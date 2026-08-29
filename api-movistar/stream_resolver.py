import httpx
import re
import subprocess
import os

async def resolve_embed_m3u8(embed_url: str, referer: str = "https://nowfutbol.xyz/") -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": referer
    }
    
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        res = await client.get(embed_url, headers=headers)
        if res.status_code != 200:
            raise ValueError(f"Embed return status {res.status_code}")
            
        scripts = re.findall(r'<script[^>]*>(.*?)</script>', res.text, re.DOTALL)
        
        target_script = None
        for s in scripts:
            if "Clappr" in s or "playbackURL" in s:
                target_script = s
                break
                
        if not target_script:
            raise ValueError("No player script found in embed")
            
        mock_dom = """
        const dummyEl = { setAttribute: () => {}, addEventListener: () => {}, style: {} };
        const window = { addEventListener: () => {} };
        const document = { addEventListener: () => {}, querySelector: () => dummyEl, getElementById: () => dummyEl, createElement: () => dummyEl, head: dummyEl, documentElement: dummyEl, body: dummyEl };
        const localStorage = { getItem: () => null, setItem: () => {} };
        const Clappr = { Player: function(opts) { console.log("RESOLVED_URL:" + opts.source); } };
        """
        
        script_path = f"/tmp/eval_{os.getpid()}.js"
        with open(script_path, "w") as f:
            f.write(mock_dom + target_script)
            
        try:
            p = subprocess.run(["node", script_path], capture_output=True, text=True, timeout=5)
            resolved_url = None
            for line in p.stdout.splitlines():
                if "RESOLVED_URL:" in line:
                    resolved_url = line.split("RESOLVED_URL:")[1].strip()
                    break
                    
            if not resolved_url:
                raise ValueError("Could not extract playbackURL from script")
                
            return resolved_url
        finally:
            if os.path.exists(script_path):
                os.remove(script_path)

if __name__ == "__main__":
    import asyncio
    url = "https://streamx-hd.com/live1.php?stream=dsports"
    resolved = asyncio.run(resolve_embed_m3u8(url))
    print("Resolved M3U8:", resolved)
