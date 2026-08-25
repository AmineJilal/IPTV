import asyncio
import subprocess
import httpx
import json
from extractors.mediaset import MediasetExtractor
from main import app

async def run_full_integration_test():
    print("========================================")
    print("MEDIASET INTEGRATION TEST")
    print("========================================")
    
    extractor = MediasetExtractor()
    
    # 1. Extractor
    try:
        res = await extractor.extract_stream("telecinco.tv")
        m3u8_url = res.get("m3u8_url", "")
        headers = res.get("headers_required", {})
        assert m3u8_url.startswith("https://directos.mediasetinfinity.es/"), f"URL inválida: {m3u8_url}"
        assert "/dai.m3u8?" in m3u8_url, "Falta /dai.m3u8 en la URL"
        assert "hdnea=" in m3u8_url and "originpath=" in m3u8_url, "Faltan parámetros hdnea/originpath"
        print("[PASS] Extractor")
    except Exception as e:
        print(f"[FAIL] Extractor: {e}")
        return False

    async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=15) as client:
        # 2. SSAI Master GET
        try:
            r_master = await client.get(m3u8_url)
            assert r_master.status_code == 200, f"HTTP {r_master.status_code}"
            print("[PASS] SSAI master")
        except Exception as e:
            print(f"[FAIL] SSAI master: {e}")
            return False

        # 3. Master #EXTM3U
        try:
            assert "#EXTM3U" in r_master.text, "Manifest no contiene #EXTM3U"
            assert len(r_master.content) > 0, "Manifest vacío"
            print("[PASS] Master #EXTM3U")
        except Exception as e:
            print(f"[FAIL] Master #EXTM3U: {e}")
            return False

        # 4. Variant GET & 5. Variant #EXTM3U
        try:
            lines = r_master.text.splitlines()
            variant_url = None
            for i, line in enumerate(lines):
                if line.strip().startswith("#EXT-X-STREAM-INF:"):
                    j = i + 1
                    while j < len(lines) and (not lines[j].strip() or lines[j].strip().startswith("#")):
                        j += 1
                    if j < len(lines):
                        variant_url = lines[j].strip()
                        break
            assert variant_url, "No se encontró variante en master"
            
            r_variant = await client.get(variant_url)
            assert r_variant.status_code == 200, f"HTTP {r_variant.status_code}"
            print("[PASS] Variant")
            
            assert "#EXTM3U" in r_variant.text, "Variante no contiene #EXTM3U"
            print("[PASS] Variant #EXTM3U")
        except Exception as e:
            print(f"[FAIL] Variant: {e}")
            return False

        # 6. Segment GET & 7. Segment bytes > 0
        try:
            v_lines = r_variant.text.splitlines()
            segment_url = None
            for l in v_lines:
                ls = l.strip()
                if ls and not ls.startswith("#") and (".ts" in ls or ".m4s" in ls):
                    segment_url = ls
                    break
            assert segment_url, "No se encontró segmento en variante"
            
            r_seg = await client.get(segment_url)
            assert r_seg.status_code == 200, f"HTTP {r_seg.status_code}"
            print("[PASS] Segment")
            
            assert len(r_seg.content) > 0, "Segmento descargado tiene 0 bytes"
            print("[PASS] Segment bytes > 0")
        except Exception as e:
            print(f"[FAIL] Segment: {e}")
            return False

    # 8. ffprobe
    try:
        header_str = f"Origin: {headers['Origin']}\r\nReferer: {headers['Referer']}\r\nUser-Agent: {headers['User-Agent']}\r\n"
        cmd = ["ffprobe", "-hide_banner", "-loglevel", "error", "-show_streams", "-headers", header_str, "-i", m3u8_url]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        assert proc.returncode == 0, f"ffprobe returncode {proc.returncode}: {proc.stderr}"
        assert "codec_type=video" in proc.stdout, "ffprobe no detectó stream de video"
        print("[PASS] ffprobe")
    except Exception as e:
        print(f"[FAIL] ffprobe: {e}")
        return False

    # 9. FastAPI Endpoint
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as fast_client:
            r_api = await fast_client.get("/api/stream/telecinco.tv")
            assert r_api.status_code == 200, f"HTTP {r_api.status_code}"
            d_api = r_api.json()
            assert d_api.get("channel_id") == "telecinco.tv"
            assert d_api.get("provider") == "mediaset"
            assert "/dai.m3u8?" in d_api.get("m3u8_url", "")
            assert "headers_required" in d_api
            print("[PASS] FastAPI endpoint")
    except Exception as e:
        print(f"[FAIL] FastAPI endpoint: {e}")
        return False

    print("========================================")
    print("ALL TESTS PASSED")
    print("========================================")
    return True

if __name__ == "__main__":
    asyncio.run(run_full_integration_test())
