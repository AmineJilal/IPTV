import base64
import json
import time
import requests


class YacineTV:

  api_url = "https://deft.yacinelive.com"
  key = "c!xZj+N9&G@Ev@vw"

  def __init__(self):
    pass

  def decrypt(self, enc, key=key):
    try:
      raw_bytes = base64.b64decode(enc.strip().encode("utf-8", errors="ignore"))
      enc_str = raw_bytes.decode("latin-1", errors="ignore")
      result = ""
      for i in range(len(enc_str)):
        result += chr(ord(enc_str[i]) ^ ord(key[i % len(key)]))
      return result
    except Exception:
      return "{}"

  def req(self, path):
    headers = {
        "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 12; M2007J3SG Build/SKQ1.210908.001)",
        "Accept": "application/json, text/plain, */*",
        "Host": "deft.yacinelive.com",
        "Connection": "Keep-Alive",
        "Accept-Encoding": "gzip"
    }
    r = requests.get(self.api_url + path, headers=headers)
    timestamp = str(int(time.time()))
    if "t" in r.headers:
      timestamp = r.headers["t"]

    try:
      return json.loads(self.decrypt(r.text, key=self.key + timestamp))

    except Exception as e:
      print(f"[-] Error de parseo o bloqueo en {path}: Código {r.status_code} - Respuesta: {r.text[:100]}")
      return {
          "success": False, 
          "error": "can't parse json.",
          "status_code": r.status_code,
          "raw_response": r.text[:200]
      }

  def get_categories(self):
    return self.req("/api/categories")

  def get_category_channels(self, category_id):
    return self.req(f"/api/categories/{str(category_id)}/channels")

  def get_channel(self, channel_id):
    return self.req(f"/api/channel/{str(channel_id)}")
