import asyncio
import subprocess
import httpx
from extractors.mediaset import MediasetExtractor

async def test_full_chain():
    extractor = MediasetExtractor()
    print("=== TEST INTEGRACIÓN Y AUTOMATIZACIÓN MEDIASET EXTRACTOR ===")
    
    # 1. Extractor
    res = await extractor.extract_stream("telecinco.tv")
    print("1. Extractor result:")
    print(f"   channel_id: {res['channel_id']}")
    print(f"   provider:   {res['provider']}")
    print(f"   m3u8_url:   {res['m3u8_url']}")
    
    headers = res['headers_required']
    master_url = res['m3u8_url']

    async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=15) as client:
        # 2. Master HTTP 200
        r_master = await client.get(master_url)
        print(f"\n2. Master SSAI HTTP status: {r_master.status_code}")
        assert r_master.status_code == 200, "Master HTTP check failed"
        assert "#EXTM3U" in r_master.text, "Master is not a valid m3u8"
        print("   Master content check: PASS (HTTP 200 & #EXTM3U)")

        # 3. Variant HTTP 200
        lines = [line.strip() for line in r_master.text.splitlines() if line.strip()]
        variants = [l for l in lines if l.startswith("https://dai.google.com")]
        assert len(variants) > 0, "No dai.google.com variants found in master"
        variant_url = variants[0]
        print(f"\n3. Testing Variant: {variant_url[:80]}...")
        r_variant = await client.get(variant_url)
        print(f"   Variant HTTP status: {r_variant.status_code}")
        assert r_variant.status_code == 200, "Variant HTTP check failed"
        assert "#EXTM3U" in r_variant.text, "Variant is not a valid m3u8"
        print("   Variant content check: PASS (HTTP 200 & #EXTM3U)")

        # 4. Segment HTTP 200
        v_lines = [l.strip() for l in r_variant.text.splitlines() if l.strip()]
        segments = [l for l in v_lines if l.startswith("https://")]
        assert len(segments) > 0, "No segments found in variant"
        seg_url = segments[0]
        print(f"\n4. Testing Segment: {seg_url[:80]}...")
        r_seg = await client.get(seg_url)
        print(f"   Segment HTTP status: {r_seg.status_code} | Size: {len(r_seg.content)} bytes")
        assert r_seg.status_code == 200, "Segment HTTP check failed"
        assert len(r_seg.content) > 1000, "Segment content is too small"
        print("   Segment content check: PASS (HTTP 200 & > 1KB)")

    # 5. ffprobe on SSAI Master URL
    print("\n5. Running ffprobe on SSAI Master URL...")
    header_str = f"Origin: {headers['Origin']}\r\nReferer: {headers['Referer']}\r\nUser-Agent: {headers['User-Agent']}\r\n"
    cmd = [
        "ffprobe", "-hide_banner",
        "-headers", header_str,
        "-i", master_url
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    print(f"   ffprobe returncode: {proc.returncode}")
    assert proc.returncode == 0, f"ffprobe failed: {proc.stderr}"
    print("   ffprobe output: OK (Media streams detected successfully)")
    
    print("\n✅ TODAS LAS PRUEBAS AUTOMÁTICAS PASARON CON ÉXITO")

if __name__ == "__main__":
    asyncio.run(test_full_chain())
