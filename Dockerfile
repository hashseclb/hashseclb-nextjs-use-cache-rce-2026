FROM node:24-bookworm-slim

ARG NEXT_VERSION=16.4.0
ENV NEXT_TELEMETRY_DISABLED=1

# ops helper used by the runMaintenanceJob Server Action
COPY ops/artifacts-maintenance /usr/local/bin/artifacts-maintenance
RUN chmod +x /usr/local/bin/artifacts-maintenance

WORKDIR /app

COPY app/package.json ./
RUN npm pkg set dependencies.next="${NEXT_VERSION}" \
 && npm install --legacy-peer-deps --no-audit --no-fund

COPY app/ ./
RUN npx next build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
