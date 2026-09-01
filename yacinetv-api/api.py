import base64
import json
import time
import requests


class YacineTV:

    api_url = "http://deft.yacinelive.com"
    key = "c!xZj+N9&G@Ev@vw"

    def __init__(self):
        self.session = requests.Session()
        self.cache = {}

    def decrypt(self, enc, key=key):
        try:
            enc = enc.strip()
            enc += "=" * (-len(enc) % 4)
            raw_bytes = base64.b64decode(enc.encode("utf-8", errors="ignore"))
            enc_str = raw_bytes.decode("latin-1", errors="ignore")
            result = ""
            for i in range(len(enc_str)):
                result += chr(ord(enc_str[i]) ^ ord(key[i % len(key)]))
            return result
        except Exception:
            return "{}"

    def req(self, path):
        # Usar caché en memoria (10 minutos TTL) para listados (no para resolver canales)
        is_list = "/api/categories" in path
        now = time.time()
        if is_list and path in self.cache:
            data, timestamp = self.cache[path]
            if now - timestamp < 600:
                return data

        domain = self.api_url.split("//")[-1].split("/")[0]
        
        headers = {
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 12; M2007J3SG Build/SKQ1.210908.001)",
            "Accept": "application/json, text/plain, */*",
            "Host": domain,
            "Connection": "Keep-Alive",
            "Accept-Encoding": "gzip"
        }
        
        # Petición Directa (Tor eliminado por lentitud y bloqueo innecesario)
        try:
            r = self.session.get(self.api_url + path, headers=headers, timeout=5.0)
            if r.status_code == 200 and "t" in r.headers:
                timestamp_str = r.headers["t"]
                decrypted = self.decrypt(r.text, key=self.key + timestamp_str)
                res = json.loads(decrypted)
                if res and (res.get("data") is not None or "data" in res or "vt" in res):
                    if is_list:
                        self.cache[path] = (res, now)
                    return res
        except Exception as e:
            print(f"[-] Error req {path}: Petición directa falló ({e}).")
        
        return {"success": False, "data": []}

    def get_categories(self):
        return self.req("/api/categories")

    def get_category_channels(self, category_id):
        return self.req(f"/api/categories/{str(category_id)}/channels")

    def get_channel(self, channel_id):
        return self.req(f"/api/channel/{str(channel_id)}")


