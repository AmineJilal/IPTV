from extractors.atresmedia import AtresmediaExtractor
from extractors.mediaset import MediasetExtractor
from extractors.rtve import RtveExtractor
from extractors.base import BaseExtractor

class StreamFactory:
    """Factory to get the correct extractor based on the channel ID or group."""
    
    @staticmethod
    def get_extractor(channel_id: str, group: str = None) -> BaseExtractor:
        cid = channel_id.lower()
        
        # Check Atresmedia channels
        if any(x in cid for x in ['antena3', 'lasexta', 'neox', 'nova', 'mega', 'atreseries']):
            return AtresmediaExtractor()
            
        # Check Mediaset channels
        if any(x in cid for x in ['telecinco', 'cuatro', 'fdf', 'divinity', 'energy', 'bemad', 'boing']):
            return MediasetExtractor()

        # Check RTVE channels
        if any(x in cid for x in ['la1', 'la2', '24h', 'teledeporte', 'tdp', 'clan', 'rtve']):
            return RtveExtractor()
            
        return None


