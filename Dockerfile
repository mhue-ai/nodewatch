FROM node:20-alpine

WORKDIR /app

# Install build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files and install
COPY package*.json ./
RUN npm install --production && npm cache clean --force

# Remove build deps to shrink image
RUN apk del python3 make g++

# Copy application
COPY src/ ./src/
COPY public/ ./public/

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/auth/challenge || exit 1

# Run
CMD ["node", "src/server.js"]
