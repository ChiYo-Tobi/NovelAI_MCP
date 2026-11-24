#!/usr/bin/env node

import { startHttpServer } from './http-app.js';
import { logFatal, onShutdown } from './runtime.js';

startHttpServer().then(({ server, close }) => {
  onShutdown(close);
  const address = server.address();
  if (address && typeof address === 'object') console.error(`NovelAI MCP 已启动，端口 ${address.port}，入口 /mcp`);
}).catch(logFatal);
