FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --include=optional --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
    && npm prune --omit=dev --include=optional --ignore-scripts --no-audit --no-fund \
    && node -e "require('sharp')"

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MCP_BIND_HOST=0.0.0.0 \
    MCP_DATA_DIR=/var/lib/novelai-mcp/data \
    MCP_IMAGE_ARCHIVE_DIR=/var/lib/novelai-mcp/images
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE ./
COPY prompts/novelAI_prompt.md ./prompts/novelAI_prompt.md
# Empty named volumes are initialized from these node-owned mount points.
RUN install -d -m 0700 -o node -g node "$MCP_DATA_DIR" "$MCP_IMAGE_ARCHIVE_DIR"
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health', {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/streamable-http-server.js"]
