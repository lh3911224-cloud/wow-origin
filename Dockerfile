FROM node:22-alpine

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV LOG_LEVEL=info
ENV TZ=Asia/Shanghai

EXPOSE 3000
USER nodejs
CMD ["npx", "tsx", "src/server.ts"]
