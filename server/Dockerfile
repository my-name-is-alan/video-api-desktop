FROM node:22-alpine

WORKDIR /app
COPY server ./server
COPY dist ./dist

ENV NODE_ENV=production
ENV BIND=0.0.0.0
EXPOSE 8787

CMD ["node", "server/server.mjs"]
