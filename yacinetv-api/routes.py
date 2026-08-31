from fastapi import APIRouter
from api import YacineTV
import re

ytv = YacineTV()
router = APIRouter(tags=["YacineTV"])


@router.get("/categories")
def categories():
    return ytv.get_categories()

@router.get("/categories/{category_id}/channels")
def channels(category_id: str):
    clean_cat = re.sub(r'^\D+', '', str(category_id))
    return ytv.get_category_channels(clean_cat or category_id)

@router.get("/channel/{channel_id}")
def channel(channel_id: str):
    # Extraer el ID numérico al final de la cadena (ej. '1080_1432' -> '1432')
    match = re.search(r'(\d+)$', str(channel_id))
    pure_id = match.group(1) if match else str(channel_id)
    return ytv.get_channel(pure_id)

