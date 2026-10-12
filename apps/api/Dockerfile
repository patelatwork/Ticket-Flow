# Build context is the repository root (npm workspaces share one lockfile):
#   docker build -f apps/api/Dockerfile .
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w @ticketflow/api --include-workspace-root

FROM deps AS build
COPY apps/api apps/api
RUN npm run build -w @ticketflow/api

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w @ticketflow/api --omit=dev && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
