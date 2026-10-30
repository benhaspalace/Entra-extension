ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG TRUSTED_REVISION
LABEL org.opencontainers.image.revision=${TRUSTED_REVISION}
WORKDIR /opt
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && chmod -R a+rX /opt/node_modules
