from typing import Dict, Any, Optional

class BaseExtractor:
    """Base class for all stream extractors."""
    
    async def extract_stream(self, channel_id: str, raw_url: str) -> Dict[str, Any]:
        """
        Extract the direct HLS stream (.m3u8) or direct video URL.
        
        Args:
            channel_id: Identifier of the channel (e.g., 'antena3', 'telecinco')
            raw_url: The original URL from the channel list (e.g., 'https://www.atresplayer.com/directos/antena3/')
            
        Returns:
            Dict containing:
                - channel_id: str
                - provider: str
                - m3u8_url: str (the final direct video stream)
                - headers_required: dict (optional)
        """
        raise NotImplementedError("This method must be overridden by subclasses.")
