# Sin dependencias externas: solo Node y los ficheros del proyecto.
# Imagen base fijada por digest; Dependabot propone las nuevas.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ENV NODE_ENV=production \
    OBSERVE_HOST=0.0.0.0 \
    OBSERVE_PORT=4982 \
    OBSERVE_DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# Sin npm, npx, yarn ni corepack: el servidor solo necesita node y así sus
# dependencias internas no entran en la imagen (ni en el escaneo de Trivy).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4982

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.OBSERVE_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
