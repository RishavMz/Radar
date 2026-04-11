import os
from dotenv import load_dotenv
load_dotenv()

from app import create_app

app = create_app()
SERVER_PORT = os.getenv("SERVER_PORT", 5000)
SERVER_HOST = os.getenv("SERVER_HOST", "0.0.0.0")

if __name__ == "__main__":
    app.run(debug=True, host=SERVER_HOST, port=SERVER_PORT)
