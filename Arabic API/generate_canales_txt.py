import os
import time
from scraper import fetch_countries, fetch_country_channels, get_all_channels_parallel, resolve_channel_details

def generate_txt(host="0.0.0.0", port=9090, filename="canales.txt"):
    print("Generating canales.txt with all channels and categories...")
    start_t = time.time()
    
    countries = fetch_countries()
    all_channels = get_all_channels_parallel()
    
    # Organize channels by country
    channels_by_country = {}
    for ch in all_channels:
        c_slug = ch['country_slug']
        if c_slug not in channels_by_country:
            channels_by_country[c_slug] = []
        channels_by_country[c_slug].append(ch)

    lines = []
    lines.append("================================================================================")
    lines.append("                     VENOLIE TV - CANALES Y CATEGORÍAS                          ")
    lines.append("================================================================================")
    lines.append(f"Fecha de Generación : {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"Servidor API Base   : http://0.0.0.0:{port}")
    lines.append(f"Total de Países     : {len(countries)}")
    lines.append(f"Total de Canales    : {len(all_channels)}")
    lines.append("================================================================================\n")

    # Categories Summary
    category_counts = {}
    for ch in all_channels:
        cat = ch.get('category', 'General')
        category_counts[cat] = category_counts.get(cat, 0) + 1

    lines.append("--------------------------------------------------------------------------------")
    lines.append("RESUMEN DE CATEGORÍAS DISPONIBLES:")
    lines.append("--------------------------------------------------------------------------------")
    for cat, count in sorted(category_counts.items(), key=lambda x: x[1], reverse=True):
        lines.append(f"  - {cat:<20}: {count} canales")
    lines.append("\n")

    # Details per Country
    for c in countries:
        c_slug = c['slug']
        c_name = c['name']
        c_channels = channels_by_country.get(c_slug, [])

        lines.append("================================================================================")
        lines.append(f"PAÍS: {c_name.upper()} ({len(c_channels)} canales)")
        lines.append("================================================================================")
        
        for idx, ch in enumerate(c_channels, 1):
            ch_id = ch['id']
            ch_name = ch['name']
            ch_cat = ch.get('category', 'General')
            ch_page = ch['page_url']
            api_stream_url = f"http://0.0.0.0:{port}/api/channels/{ch_id}/stream"
            
            lines.append(f"[{idx:02d}] {ch_name}")
            lines.append(f"     ID           : {ch_id}")
            lines.append(f"     País         : {c_name}")
            lines.append(f"     Categoría    : {ch_cat}")
            lines.append(f"     Página Web   : {ch_page}")
            lines.append(f"     Stream API   : {api_stream_url}")
            lines.append("--------------------------------------------------------------------------------")
        lines.append("\n")

    content = "\n".join(lines)
    with open(filename, "w", encoding="utf-8") as f:
        f.write(content)

    elapsed = round(time.time() - start_t, 2)
    print(f"✅ {filename} generado exitosamente ({len(all_channels)} canales) en {elapsed}s.")
    return filename

if __name__ == "__main__":
    generate_txt()
