"""
Web scraping utility for the WhatsApp Agent backend.
Uses Scrapling for anti-bot bypassing requests and markdownify for clean HTML-to-Markdown conversion.
"""

from __future__ import annotations

import logging
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from scrapling import Fetcher

logger = logging.getLogger(__name__)


def scrape_url(url: str) -> str:
    """
    Fetch a webpage, strip clutter elements (scripts, styles, nav, header, footer),
    and convert the remaining HTML to clean Markdown.
    
    Capped at 50,000 characters.
    """
    try:
        logger.info("Scraping URL: %s", url)
        
        # 1. Fetch webpage (Scrapling has built-in stealth fetchers)
        response = Fetcher.get(url, timeout=15)
        
        if not response.body:
            raise RuntimeError(f"Scrapling returned empty response for {url}")

        # Decode response body to string
        html_text = response.body.decode("utf-8", errors="ignore")

        # 2. Parse HTML and strip clutter elements
        soup = BeautifulSoup(html_text, "lxml")
        
        # Decompose script, style, navigation, headers, and footers
        for element in soup(["script", "style", "nav", "header", "footer", "iframe", "noscript"]):
            element.decompose()

        # Get cleaned HTML string
        clean_html = str(soup)

        # 3. Convert HTML to clean Markdown
        # Strip images to avoid markdown image link clutter
        markdown_text = md(
            clean_html,
            heading_style="ATX",  # Use # instead of Underline
            strip=["img"]
        ).strip()

        # Collapse multiple empty lines
        lines = [line.strip() for line in markdown_text.splitlines()]
        cleaned_lines = []
        for line in lines:
            if line:
                cleaned_lines.append(line)
            elif not cleaned_lines or cleaned_lines[-1] != "":
                cleaned_lines.append("")
        
        markdown_text = "\n".join(cleaned_lines).strip()

        # 4. Truncate if it exceeds limits
        limit = 50000
        if len(markdown_text) > limit:
            logger.info("Scraped text length (%d chars) exceeds limit, truncating", len(markdown_text))
            markdown_text = (
                markdown_text[:limit]
                + "\n\n[Content truncated due to length limits. Ask the agent if you want to explore specific sections further.]"
            )

        logger.info("Scraped URL complete (%d chars)", len(markdown_text))
        return markdown_text

    except Exception as e:
        logger.exception("Failed to scrape URL %s: %s", url, e)
        raise RuntimeError(f"Failed to load page: {e}")
