"""
Pydantic request model for VOG (Voice of God / emergency) messages -
deliberately no timing fields, since VOG is manual-trigger only (see
docs/03-domain-concepts.md).
"""

from pydantic import BaseModel, field_validator


class VogMessageRequest(BaseModel):
    name: str
    qlab_cue_number: str
    enabled: bool = True

    @field_validator("name", "qlab_cue_number")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("must not be blank")
        return value.strip()

    def to_node_red_payload(self) -> dict:
        return {
            "name": self.name,
            "qlabCueNumber": self.qlab_cue_number,
            "enabled": self.enabled,
        }
