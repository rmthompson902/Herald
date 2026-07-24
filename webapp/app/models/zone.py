"""
Pydantic request model mirroring lib/zones/audioPatchMap.js's validateAndBuildMaps rules,
for instant client-side feedback only. This is UX duplication, not business-logic
duplication: Node-RED's validateAndBuildMaps still runs on every write (via core.zones.save)
and remains the actual authority - a passing check here never skips the proxy call.

zone_name identifies which zone a create/update targets. For an update, the URL's
:zoneName path segment is what Node-RED actually keys off - this model's zone_name is
only used (and required) on create.
"""

from pydantic import BaseModel, field_validator


class ZoneRequest(BaseModel):
    zone_name: str
    messaging_patch_id: str
    duck_cue_number: str
    unduck_cue_number: str

    @field_validator("zone_name", "messaging_patch_id", "duck_cue_number", "unduck_cue_number")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value or not str(value).strip():
            raise ValueError("must not be blank")
        return str(value).strip()

    def to_node_red_payload(self) -> dict:
        return {
            "zoneName": self.zone_name,
            "messagingPatchId": self.messaging_patch_id,
            "duckCueNumber": self.duck_cue_number,
            "unduckCueNumber": self.unduck_cue_number,
        }
