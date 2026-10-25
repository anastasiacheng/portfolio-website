"""Adds projects from a JSON file as drafts, skipping ids that already exist.
Usage: python3 -m server.seed seed/projects.json"""
import json
import sys
from pathlib import Path

from .app import Config
from .portfolio import Portfolio

if __name__ == "__main__":
    source = Path(sys.argv[1])
    config = Config()
    portfolio = Portfolio(config.state_dir, config.site_dir, config.template)
    state = portfolio.view()
    existing = {d["id"] for d in state["drafts"]}
    added = []
    for item in json.loads(source.read_text()):
        if item["id"] in existing:
            continue
        image = item.pop("imagePath", None)
        if image:
            item["image"] = {"file": portfolio.add_image((source.parent / image).read_bytes()), "alt": item.pop("imageAlt")}
        added.append(item)
    if added:
        portfolio.save_drafts(state["revision"], state["drafts"] + added)
    print(f"Added {len(added)} draft(s): {', '.join(p['title'] for p in added) or 'none'}")
