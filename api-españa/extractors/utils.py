def normalize_channel_id(channel_id: str) -> str:
    """
    Normalizes any channel ID format into a clean base slug.
    Examples:
    - 'tdt_antena3' -> 'antena3'
    - 'antena3.tv'  -> 'antena3'
    - 'antena3'     -> 'antena3'
    - 'tdt_lasexta' -> 'lasexta'
    """
    if not channel_id:
        return ""
    cid = channel_id.lower().strip()
    if cid.startswith("tdt_"):
        cid = cid[4:]
    if cid.endswith(".tv"):
        cid = cid[:-3]
    return cid
