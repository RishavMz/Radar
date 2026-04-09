from dotenv import load_dotenv
load_dotenv()  # Must run before any app import so os.getenv picks up .env

import os
from app import create_app

app = create_app()

if __name__ == "__main__":
    app.run(
        debug=app.config.get("DEBUG", False),
        host=os.getenv("FLASK_HOST", "0.0.0.0"),
        port=int(os.getenv("FLASK_PORT", 5000)),
    )
