# syntax=docker/dockerfile:1

# Build stage: installs all workspaces and builds the web SPA.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: only the server workspace's own dependencies, plus the built SPA.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev -w server
COPY server ./server
COPY shared ./shared
COPY --from=build /app/web/dist ./web/dist
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require(process.env.TLS_CERT_PATH?'node:https':'node:http').request({host:'localhost',port:process.env.PORT||8787,path:'/api/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).end()"
CMD ["npm", "run", "start"]
