import uvicorn
import os
import sys
from app.config import settings

if __name__ == "__main__":
    port = int(os.getenv("PORT", settings.PORT))
    host = os.getenv("HOST", settings.HOST)
    
    print(f"============================================================")
    print(f"  Starting {settings.PROJECT_NAME} v{settings.VERSION}")
    print(f"  Server running on http://{host}:{port}")
    print(f"  Web Dashboard: http://localhost:{port}/")
    print(f"  API Docs (Swagger): http://localhost:{port}/docs")
    print(f"  IPTV Playlist M3U: http://localhost:{port}/playlist.m3u")
    print(f"============================================================")
    
    uvicorn.run("app.main:app", host=host, port=port, reload=False)
