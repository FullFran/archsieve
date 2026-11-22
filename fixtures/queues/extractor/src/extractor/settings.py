import os
from dataclasses import dataclass


@dataclass
class Settings:
    exchange: str
    queue: str
    request_key: str


def load() -> Settings:
    return Settings(
        exchange=os.getenv("RABBITMQ_EXCHANGE", "events"),
        queue=os.getenv("EXTRACT_QUEUE", "extractor.requests"),
        request_key=os.getenv(
            "EXTRACT_REQUEST_KEY", "doc.extract.requested"
        ),
    )
