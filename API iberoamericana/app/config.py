import os

class Settings:
    PROJECT_NAME: str = "Futbol Libre TV API"
    VERSION: str = "1.0.0"
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", 8090))  # Launched on port 8090 (different from 3000, 8000, 8080)
    
    BASE_URL: str = "https://futbollibretv.sx"
    CONFIG_PATH: str = "/config.js"
    EVENTOS_PATH: str = "/eventos.js"
    
    # Default fallback iframe domain if config parsing fails
    DEFAULT_IFRAME_DOMAIN: str = "streamtp-golden1.click"
    DEFAULT_BASE_PATH: str = "/global1.php?stream="
    
    USER_AGENT: str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    
    CACHE_TTL_SECONDS: int = 60  # Cache agenda & config for 60 seconds

settings = Settings()
