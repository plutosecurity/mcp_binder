import http from "node:http";

const HOST = "127.0.0.1";
const BASE_PORT = Number.parseInt(process.env.MOCK_MCP_BASE_PORT || "8080", 10);
const TARGETS = [
  {
    offset: 0,
    name: "streamable-json",
    handler: streamableJson
  },
  {
    offset: 1,
    name: "streamable-sse",
    handler: streamableSse
  },
  {
    offset: 2,
    name: "legacy-sse",
    handler: legacySse
  },
  {
    offset: 3,
    name: "strict-origin",
    handler: strictOrigin
  },
  {
    offset: 4,
    name: "streamable-post-required",
    handler: streamablePostRequired
  },
  {
    offset: 5,
    name: "streamable-protocol-fallback",
    handler: streamableProtocolFallback
  },
  {
    offset: 6,
    name: "generic-sse-noise",
    handler: genericSseNoise
  },
  {
    offset: 7,
    name: "better-gitlab-post-sse",
    handler: betterGitlabPostSse
  },
  {
    offset: 8,
    name: "worldpay-mcp-only",
    handler: worldpayMcpOnly
  },
  {
    offset: 9,
    name: "streamable-auth-required",
    handler: streamableAuthRequired
  },
  {
    offset: 10,
    name: "streamable-jsonrpc-error",
    handler: streamableJsonRpcError
  },
  {
    offset: 11,
    name: "authenticated-context",
    handler: authenticatedContext
  },
  {
    offset: 12,
    name: "root-streamable-sse",
    handler: rootStreamableSse
  }
];

const servers = [];

for (const target of TARGETS) {
  const port = BASE_PORT + target.offset;
  const server = http.createServer((req, res) => {
    readJsonBody(req).then((body) => target.handler(req, res, body));
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, resolve);
    });
  } catch (error) {
    console.error(`Failed to bind ${target.name} on ${HOST}:${port}: ${error.message}`);
    shutdown(1);
  }

  servers.push(server);
  console.log(`${target.name}: http://${HOST}:${port}`);
}

console.log("Mock MCP lab running. Press Ctrl+C to stop.");

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function streamableJson(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (req.method === "GET") {
    return json(res, 200, {
      mcp: true,
      transport: "streamable-http"
    });
  }

  if (req.method !== "POST") {
    return notFound(res);
  }

  if (body.method === "initialize") {
    return json(res, 200, initializeResult(body.id, "streamable-json", "1.0.0"), {
      "mcp-session-id": "streamable-json-session"
    });
  }

  if (body.method === "tools/list") {
    return json(res, 200, toolsResult(body.id, "json_read_project"));
  }

  return json(res, 202, {});
}

function streamableSse(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (req.method === "GET") {
    return sse(res, {
      jsonrpc: "2.0",
      method: "notifications/ready",
      params: {
        mcp: true
      }
    });
  }

  if (req.method !== "POST") {
    return notFound(res);
  }

  if (body.method === "initialize") {
    return sse(res, initializeResult(body.id, "streamable-sse", "1.0.0"), {
      "mcp-session-id": "streamable-sse-session"
    });
  }

  if (body.method === "tools/list") {
    return sse(res, toolsResult(body.id, "sse_list_groups"));
  }

  res.writeHead(202);
  res.end();
}

function legacySse(req, res, body) {
  if (req.url === "/sse" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream"
    });
    res.end("event: endpoint\ndata: /messages?sessionId=legacy\n\n");
    return;
  }

  if (req.url.startsWith("/messages") && req.method === "POST") {
    if (body.method === "tools/list") {
      return json(res, 200, toolsResult(body.id, "legacy_echo"));
    }

    return json(res, 200, initializeResult(body.id, "legacy-sse", "0.9.0"));
  }

  notFound(res);
}

function strictOrigin(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (req.headers.origin === "https://researcher.example") {
    return json(res, 403, {
      error: "blocked forged origin"
    });
  }

  if (req.method === "GET") {
    return json(res, 200, {
      mcp: true,
      transport: "streamable-http"
    });
  }

  if (body.method === "initialize") {
    return json(res, 200, initializeResult(body.id, "strict-origin", "1.0.0"));
  }

  if (body.method === "tools/list") {
    return json(res, 200, toolsResult(body.id, "strict_status"));
  }

  return json(res, 202, {});
}

function streamablePostRequired(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (req.method === "GET") {
    return json(res, 405, {
      error: "Method Not Allowed",
      message: "GET /mcp is not supported when STREAMABLE_HTTP is enabled. Use POST to communicate with the MCP server."
    });
  }

  if (body.method === "initialize") {
    return json(res, 200, initializeResult(body.id, "streamable-post-required", "1.0.0"));
  }

  if (body.method === "tools/list") {
    return json(res, 200, toolsResult(body.id, "post_required_tool"));
  }

  return json(res, 202, {});
}

function streamableProtocolFallback(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (req.method === "GET") {
    return json(res, 405, {
      error: "Method Not Allowed",
      message: "GET /mcp is not supported when STREAMABLE_HTTP is enabled. Use POST to communicate with the MCP server."
    });
  }

  const protocolVersion = req.headers["mcp-protocol-version"];

  if (body.method === "initialize") {
    if (protocolVersion !== "2024-11-05") {
      return json(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32602,
          message: `Unsupported protocol version ${protocolVersion}`
        }
      });
    }

    return json(res, 200, initializeResult(body.id, "streamable-protocol-fallback", "1.0.0", "2024-11-05"), {
      "mcp-session-id": "fallback-session"
    });
  }

  if (body.method === "tools/list") {
    if (protocolVersion !== "2024-11-05") {
      return json(res, 400, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32602,
          message: "Wrong protocol version for tool listing"
        }
      });
    }

    return json(res, 200, toolsResult(body.id, "fallback_tool"));
  }

  return json(res, 202, {});
}

function betterGitlabPostSse(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (req.method === "GET") {
    return json(res, 405, {
      error: "Method Not Allowed",
      message: "GET /mcp is not supported when STREAMABLE_HTTP is enabled. Use POST to communicate with the MCP server."
    });
  }

  const protocolVersion = req.headers["mcp-protocol-version"];

  if (body.method === "initialize") {
    return sse(res, initializeResult(body.id, "better-gitlab-mcp-server", "2.1.18", "2024-11-05"), {
      "mcp-session-id": "better-gitlab-session"
    });
  }

  if (body.method === "tools/list") {
    if (protocolVersion !== "2024-11-05") {
      return sse(res, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32602,
          message: `Wrong protocol version ${protocolVersion}`
        }
      });
    }

    if (req.headers["mcp-session-id"] !== "better-gitlab-session") {
      return sse(res, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32000,
          message: "Missing session"
        }
      });
    }

    return sse(res, toolsResult(body.id, "gitlab_get_project"));
  }

  res.writeHead(202);
  res.end();
}

function worldpayMcpOnly(req, res, body) {
  if (req.url !== "/mcp") {
    req.socket.destroy();
    return;
  }

  if (req.method === "GET") {
    return json(res, 405, {
      error: "Method Not Allowed",
      message: "GET /mcp is not supported when STREAMABLE_HTTP is enabled. Use POST to communicate with the MCP server."
    });
  }

  if (body.method === "initialize") {
    return sse(res, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: true
          }
        },
        serverInfo: {
          name: "Worldpay",
          version: "1.0.3"
        }
      }
    }, {
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "Mcp-Session-Id",
      "mcp-session-id": "worldpay-session"
    });
  }

  if (body.method === "tools/list") {
    return sse(res, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [
          {
            name: "create_hosted_payment",
            title: "Create Hosted Payment",
            description: "Create a hosted payment page link to send to customers",
            inputSchema: {
              type: "object",
              properties: {
                amount: {
                  type: "number"
                },
                currency: {
                  type: "string"
                }
              }
            }
          }
        ]
      }
    });
  }

  res.writeHead(202);
  res.end();
}

function streamableAuthRequired(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (req.method === "GET") {
    return json(res, 405, {
      error: "Method Not Allowed",
      message: "GET /mcp is not supported when STREAMABLE_HTTP is enabled. Use POST to communicate with the MCP server."
    });
  }

  if (body.method === "initialize") {
    return sse(res, initializeResult(body.id, "better-gitlab-mcp-server", "2.1.18", "2025-06-18"), {
      "mcp-session-id": "auth-required-session"
    });
  }

  if (body.method === "notifications/initialized" || body.method === "tools/list") {
    return json(res, 401, {
      error: "Missing Private-Token, JOB-TOKEN, or Authorization header",
      message: "Remote authorization is enabled. Please provide Private-Token, JOB-TOKEN, or Authorization header."
    });
  }

  return json(res, 202, {});
}

function streamableJsonRpcError(req, res) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  return json(res, 200, {
    jsonrpc: "2.0",
    error: {
      code: -32603,
      message: "Internal Server Error"
    },
    id: null
  });
}

function authenticatedContext(req, res, body) {
  if (req.url !== "/mcp") {
    return notFound(res);
  }

  if (body.method === "initialize") {
    return json(res, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false
          },
          prompts: {
            listChanged: false
          }
        },
        serverInfo: {
          name: "@huggingface/mcp-services",
          version: "0.3.28",
          title: "Hugging Face"
        },
        instructions: "Hugging Face tools are being used by authenticated user 'mock-user'."
      }
    });
  }

  if (body.method === "tools/list") {
    return json(res, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: []
      }
    });
  }

  return json(res, 202, {});
}

function rootStreamableSse(req, res, body) {
  if (req.url !== "/") {
    return notFound(res);
  }

  if (req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html"
    });
    res.end("<!doctype html><title>Tapo</title>");
    return;
  }

  if (body.method === "initialize") {
    return sse(res, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          resources: {},
          tools: {}
        },
        serverInfo: {
          name: "tapo-mcp",
          title: "Tapo MCP Server",
          version: "0.4.0"
        },
        instructions: "Control and monitor Tapo smart home devices."
      }
    }, {
      "mcp-session-id": "tapo-root-session"
    });
  }

  if (body.method === "tools/list") {
    return sse(res, toolsResult(body.id, "list_devices"));
  }

  res.writeHead(202);
  res.end();
}

function genericSseNoise(req, res) {
  if (req.url === "/sse") {
    res.writeHead(200, {
      "content-type": "text/event-stream"
    });
    res.end("event: ping\ndata: hello\n\n");
    return;
  }

  notFound(res);
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function initializeResult(id, name, version, protocolVersion = "2025-06-18") {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name,
        version
      }
    }
  };
}

function toolsResult(id, toolName) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: [
        {
          name: toolName,
          description: "Mock lab tool"
        }
      ]
    }
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function sse(res, body, headers = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    ...headers
  });
  res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
}

function notFound(res) {
  res.writeHead(404, {
    "content-type": "text/plain"
  });
  res.end("not found");
}

function shutdown(code = 0) {
  for (const server of servers) {
    server.close();
  }

  process.exit(code);
}
