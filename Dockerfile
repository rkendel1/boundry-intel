FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production BOUNDRY_INTEL_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY schema ./schema
# Runs as root because a Fly volume is mounted root-owned; the VM is the isolation boundary.
EXPOSE 8080
CMD ["node", "src/main.mjs"]
