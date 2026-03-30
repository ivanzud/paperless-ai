# Deployment Notes

The deployment-safe container path lives in `docker-compose.ghcr.yml`.

Use it when you want the published GHCR image instead of the source-based local development workflow:

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

The compose file uses `ghcr.io/ivanzud/paperless-ai:latest`, mounts `/app/data` as a named volume, and leaves the local `docker-compose.yml` unchanged.
