import asyncio
from fastapi.testclient import TestClient
from main import app
from xameleon_extractor import fetch_xameleon_channels, resolve_xameleon_stream, fetch_xameleon_m3u8_manifest

client = TestClient(app)

def test_xameleon_extractor_direct():
    """Prueba directamente las funciones del extractor Xameleon"""
    channels = asyncio.run(fetch_xameleon_channels())
    assert isinstance(channels, list)
    assert len(channels) > 0
    print(f"\n[OK] Extractor Xameleon trajo {len(channels)} canales!")
    
    # Probar resolución de stream para canal 91
    m3u8_url = asyncio.run(resolve_xameleon_stream("91"))
    assert m3u8_url.startswith("https://")
    assert "premium91" in m3u8_url
    print(f"[OK] Stream M3U8 resuelto correctamente: {m3u8_url}")
    
    # Descargar manifiesto M3U8 con bypass de SNI
    manifest = asyncio.run(fetch_xameleon_m3u8_manifest(m3u8_url))
    assert "#EXTM3U" in manifest
    print("[OK] Manifiesto HLS descargado exitosamente!")

def test_xameleon_api_endpoints():
    """Prueba los endpoints FastAPI expuestos"""
    # 1. Obtener catálogo Xameleon
    resp = client.get("/api/v1/xameleon/channels")
    assert resp.status_code == 200
    channels = resp.json()
    assert len(channels) > 0
    
    # 2. Obtener URL resuelta para canal 91
    resp_m3u8 = client.get("/api/v1/channel/xameleon_91/m3u8")
    assert resp_m3u8.status_code == 200
    data = resp_m3u8.json()
    assert "stream_url" in data
    assert "premium91" in data["stream_url"]
    
    # 3. Proxy manifiesto HLS
    resp_proxy = client.get("/api/v1/channel/xameleon_91/proxy-stream")
    assert resp_proxy.status_code == 200
    assert "#EXTM3U" in resp_proxy.text

if __name__ == "__main__":
    test_xameleon_extractor_direct()
    test_xameleon_api_endpoints()
    print("\n[ÉXITO TOTAL] Todas las pruebas de Xameleon pasaron satisfactoriamente!")
