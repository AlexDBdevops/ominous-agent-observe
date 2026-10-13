# Sin dependencias externas: solo Node y los ficheros del proyecto.
FROM node:24-alpine

ENV NODE_ENV=production \
    OBSERVE_HOST=0.0.0.0 \
    OBSERVE_PORT=4982 \
    OBSERVE_DATA_DIR=/data \
    OBSERVE_TRANSCRIPTS_DIR=/claude-projects

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4982

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.OBSERVE_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
