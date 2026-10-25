"""Re-renders the public index.html from the current template: python3 -m server.rebuild"""
from .app import Config
from .portfolio import Portfolio

if __name__ == "__main__":
    config = Config()
    Portfolio(config.state_dir, config.site_dir, config.template).render_site()
    print(f"Rebuilt {config.site_dir / 'index.html'}")
