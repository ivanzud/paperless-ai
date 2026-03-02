FROM astral/uv:python3.12-trixie-slim AS python-builder

WORKDIR /app

# Default: CPU (no extra). GPU build: pass --build-arg TORCH_EXTRA=gpu
ARG TORCH_EXTRA=""
ENV UV_COMPILE_BYTECODE=false
ENV UV_PROJECT_ENVIRONMENT=/app/venv

# Install Python dependencies for RAG service in a virtual environment
COPY pyproject.toml uv.lock ./
RUN if [ -n "$TORCH_EXTRA" ]; then \
  uv sync --frozen --no-dev --extra "$TORCH_EXTRA"; \
  else \
  uv sync --frozen --no-dev; \
  fi && \
  find /app/venv -type d -name 'tests' -exec rm -rf {} + && \
  find /app/venv -type d -name 'test' -exec rm -rf {} +

FROM node:22-trixie-slim AS node-builder

ENV PNPM_HOME=/usr/local/bin

WORKDIR /app

# Install PM2 process manager globally
RUN corepack enable && pnpm install pm2 -g

# Copy package files for dependency installation
COPY package*.json ./

# Install node dependencies with clean install
RUN pnpm install --prod && pnpm store prune

FROM node:22-trixie-slim

WORKDIR /app

# Install system dependencies and clean up in single layer
RUN apt-get update && \
  apt-get install -y --no-install-recommends \
  curl \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Copy Python virtual environment from builder
COPY --from=python-builder /app/venv /app/venv
COPY --from=python-builder /usr/local/bin /usr/local/bin
COPY --from=python-builder /usr/local/include/python3.12 /usr/local/include/python3.12
COPY --from=python-builder /usr/local/lib /usr/local/lib

# Copy Node.js dependencies from builder
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-builder /usr/local/bin /usr/local/bin

# Copy application source code
COPY . .

# Make startup script executable
RUN chmod u+x start-services.sh

# Configure persistent data volume
VOLUME ["/app/data"]

# Configure application port - aber der tatsächliche Port wird durch PAPERLESS_AI_PORT bestimmt
EXPOSE ${PAPERLESS_AI_PORT:-3000}

# Add health check with dynamic port
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PAPERLESS_AI_PORT:-3000}/health || exit 1

# Set production environment
ENV NODE_ENV=production

# Start both Node.js and Python services using our script
CMD ["/app/start-services.sh"]