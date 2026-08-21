import requests
import json

BASE_URL = "http://localhost:8080"

def test_endpoint(name, path, params=None):
    url = BASE_URL + path
    print(f"\n==========================================")
    print(f"TESTING: {name} ({path})")
    print(f"==========================================")
    try:
        r = requests.get(url, params=params, allow_redirects=False, timeout=5)
        print("Status Code:", r.status_code)
        if r.status_code in [200, 307]:
            if 'application/json' in r.headers.get('Content-Type', ''):
                print("Response JSON:")
                print(json.dumps(r.json(), indent=2)[:1000])
            elif 'text/plain' in r.headers.get('Content-Type', '') or path.endswith('.m3u'):
                print("Response text sample (first 10 lines):")
                print("\n".join(r.text.splitlines()[:10]))
            else:
                print("Headers:", dict(r.headers))
        else:
            print("Error response:", r.text[:300])
    except Exception as e:
        print("Error connecting:", e)

if __name__ == "__main__":
    test_endpoint("Health Check", "/api/health")
    test_endpoint("List Countries", "/api/countries")
    test_endpoint("Country Detail Morocco", "/api/countries/morocco")
    test_endpoint("Morocco Channels", "/api/countries/morocco/channels")
    test_endpoint("List Categories", "/api/categories")
    test_endpoint("Channels List (Morocco)", "/api/channels", {"country": "morocco", "limit": 3})
    test_endpoint("Channel Detail (2M)", "/api/channels/2m")
    test_endpoint("Channel Stream Info (2M)", "/api/channels/2m/stream", {"redirect": False})
    test_endpoint("Channel Stream Info (M24)", "/api/channels/m24/stream", {"redirect": False})
    test_endpoint("Channel Stream Redirect (2M)", "/api/channels/2m/stream", {"redirect": True})
    test_endpoint("IPTV M3U Playlist", "/playlist.m3u", {"country": "morocco"})
