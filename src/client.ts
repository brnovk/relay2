import WebSocket from 'ws';
import { request } from 'http';

interface ClientOptions {
  target: string;
  server?: string;
  secret?: string;
  subdomain?: string;
}

export function startClient(options: ClientOptions) {
  const SERVER = options.server || process.env.SERVER;
  const SECRET = options.secret || process.env.SECRET;
  const SUBDOMAIN = options.subdomain || process.env.SUBDOMAIN;
  const TARGET = options.target || process.env.TARGET;

  if (!SERVER) {
    console.error('❌ ERROR: Server hostname required');
    console.error('   Use: relay 3000 --server tunnel.example.com');
    console.error('   Or set SERVER environment variable');
    process.exit(1);
  }

  if (!SECRET) {
    console.error('❌ ERROR: Authentication secret required');
    console.error('   Use: relay 3000 --secret your-secret');
    console.error('   Or set SECRET environment variable');
    process.exit(1);
  }

  if (!TARGET) {
    console.error('❌ ERROR: Target required');
    console.error('   Usage: relay 3000');
    console.error('   Usage: relay app:3000');
    process.exit(1);
  }

  // Parse target
  let targetHost: string;
  let targetPort: number;

  if (TARGET.includes(':')) {
    const [host, port] = TARGET.split(':');
    targetHost = host;
    targetPort = parseInt(port, 10);
  } else {
    targetHost = 'localhost';
    targetPort = parseInt(TARGET, 10);
  }

  if (isNaN(targetPort)) {
    console.error(`❌ ERROR: Invalid target port: ${TARGET}`);
    process.exit(1);
  }

  const localUrl = `http://${targetHost}:${targetPort}`;

  // Auto-detect protocol: use ws:// for localhost/127.0.0.1, wss:// for everything else
  let serverUrl: string;
  if (SERVER.startsWith('ws://') || SERVER.startsWith('wss://')) {
    serverUrl = SERVER;
  } else {
    const isLocalhost = SERVER.includes('localhost') || SERVER.includes('127.0.0.1');
    const protocol = isLocalhost ? 'ws' : 'wss';
    serverUrl = `${protocol}://${SERVER}/relay`;
  }

  let ws: WebSocket | null = null;
  let reconnectTimeout: NodeJS.Timeout | null = null;
  let pingInterval: NodeJS.Timeout | null = null;
  let isConnected = false;
  let assignedSubdomain: string | null = SUBDOMAIN || null;

  function connect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    console.log(`Connecting to ${SERVER}...`);
    ws = new WebSocket(serverUrl);

    ws.on('open', () => {
      console.log('✓ Connected to server');
      isConnected = true;

      const authMessage: any = {
        type: 'auth',
        secret: SECRET
      };

      if (assignedSubdomain) {
        authMessage.subdomain = assignedSubdomain;
        console.log(`Requesting subdomain: ${assignedSubdomain}`);
      }

      ws!.send(JSON.stringify(authMessage));

      // Start heartbeat - ping every 30 seconds to keep connection alive
      if (pingInterval) {
        clearInterval(pingInterval);
      }
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30000);
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ready') {
          // Store the assigned subdomain for reconnections
          if (msg.subdomain && !assignedSubdomain) {
            assignedSubdomain = msg.subdomain;
          }

          console.log();
          console.log(`🔄 Relay active!`);
          console.log(`   ${msg.url}`);
          console.log(`   → ${localUrl}`);
          console.log();
        }

        if (msg.type === 'error') {
          console.error(`❌ Server error: ${msg.message}`);
          process.exit(1);
        }

        if (msg.type === 'request') {
          try {
            const url = localUrl + msg.path;

            // ────────────────────────────────────────────────────────────────
            // ПОЛНЫЙ ДАМП ВХОДЯЩЕГО ЗАПРОСА
            console.log(`[relay-incoming FULL DUMP]`);
            console.log(`Method: ${msg.method}`);
            console.log(`Path: ${msg.path}`);
            console.log(`Request ID: ${msg.id}`);
            console.log(`Incoming Headers (raw):`);
            console.dir(msg.headers, { depth: null, colors: true });
            console.log(`Incoming Body (raw, length ${msg.body?.length || 0}):`);
            if (msg.body) {
              console.log(msg.body);
            } else {
              console.log('<no body>');
            }
            console.log(`─`.repeat(80));
            // ────────────────────────────────────────────────────────────────

            const originalHeaders = { ...msg.headers };
            const forwardHeaders: Record<string, string> = {
              ...originalHeaders,
              host: `${targetHost}:${targetPort}`
            };

            let forwardBody: string | undefined = msg.body;

            // Aggressive strip for GET/HEAD
            if (msg.method === 'GET' || msg.method === 'HEAD') {
              if (msg.body || forwardHeaders['content-length'] || forwardHeaders['Content-Length'] || forwardHeaders['transfer-encoding']) {
                console.log(
                    `[relay-patch-debug] STRIPPING GET/HEAD` +
                    ` cl: ${forwardHeaders['content-length'] || forwardHeaders['Content-Length'] || 'none'}` +
                    ` body len: ${msg.body?.length || 0}`
                );

                // Show body content if present
                if (msg.body) {
                  console.log(`[relay-patch-debug] BODY BEFORE STRIP:`);
                  console.log(msg.body);
                }

                // Force clear
                forwardBody = undefined;

                // Удаляем все возможные варианты заголовков
                Object.keys(forwardHeaders).forEach(key => {
                  if (key.toLowerCase() === 'content-length' || key.toLowerCase() === 'transfer-encoding') {
                    delete forwardHeaders[key];
                  }
                });
              }
            }

            // ────────────────────────────────────────────────────────────────
            // ПОЛНЫЙ ДАМП ИСХОДЯЩЕГО ЗАПРОСА ПЕРЕД ОТПРАВКОЙ
            console.log(`[relay-outgoing FULL DUMP]`);
            console.log(`Method: ${msg.method}`);
            console.log(`Path: ${msg.path}`);
            console.log(`Outgoing Headers (after patch):`);
            console.dir(forwardHeaders, { depth: null, colors: true });
            console.log(`Outgoing Body (after patch, length ${forwardBody?.length || 0}):`);
            if (forwardBody) {
              console.log(forwardBody);
            } else {
              console.log('<no body>');
            }
            console.log(`─`.repeat(80));
            // ────────────────────────────────────────────────────────────────

            const options = {
              hostname: targetHost,
              port: targetPort,
              path: msg.path,
              method: msg.method,
              headers: forwardHeaders
            };

            const proxyReq = request(options, (proxyRes) => {
              const status = proxyRes.statusCode || 200;

              const responseHeaders: Record<string, string> = {};
              Object.entries(proxyRes.headers).forEach(([key, value]) => {
                if (typeof value === 'string') responseHeaders[key] = value;
                else if (Array.isArray(value)) responseHeaders[key] = value.join(', ');
              });

              const chunks: Buffer[] = [];
              proxyRes.on('data', chunk => chunks.push(Buffer.from(chunk)));
              proxyRes.on('end', () => {
                const arrayBuffer = Buffer.concat(chunks);
                const responseBody = arrayBuffer.toString('base64');

                ws!.send(JSON.stringify({
                  type: 'response',
                  id: msg.id,
                  status,
                  headers: responseHeaders,
                  body: responseBody,
                  encoding: 'base64'
                }));
              });
            });

            proxyReq.on('error', (err) => {
              console.error(`Error forwarding request: ${err.message}`);
              ws!.send(JSON.stringify({
                type: 'response',
                id: msg.id,
                status: 502,
                headers: { 'content-type': 'text/plain' },
                body: Buffer.from(`Bad Gateway: ${err.message}`).toString('base64'),
                encoding: 'base64'
              }));
            });

            if (forwardBody) {
              proxyReq.write(forwardBody);
            }
            proxyReq.end();

          } catch (error) {
            const err = error as Error;
            console.error(`Error forwarding request: ${err.message}`);

            ws!.send(JSON.stringify({
              type: 'response',
              id: msg.id,
              status: 502,
              headers: { 'content-type': 'text/plain' },
              body: Buffer.from(`Bad Gateway: ${err.message}`).toString('base64'),
              encoding: 'base64'
            }));
          }
        }
      } catch (err) {
        console.error('Error handling message:', err);
      }
    });

    ws.on('close', () => {
      isConnected = false;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      console.log('✗ Disconnected from server');
      console.log('Reconnecting in 5 seconds...');
      reconnectTimeout = setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  }

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    if (pingInterval) {
      clearInterval(pingInterval);
    }
    if (ws) {
      ws.close();
    }
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    if (pingInterval) {
      clearInterval(pingInterval);
    }
    if (ws) {
      ws.close();
    }
    process.exit(0);
  });

  connect();
}
