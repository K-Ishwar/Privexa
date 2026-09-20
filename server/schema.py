"""Strict, privacy-preserving wire models for the local planner."""
from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID
import re

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StrictInt, field_validator, model_validator

I = Annotated[StrictInt, Field(ge=0, le=10000)]
ViewportI = Annotated[StrictInt, Field(ge=1, le=10000)]
Amount = Annotated[StrictInt, Field(ge=-800, le=800)]
Duration = Annotated[FiniteFloat, Field(ge=0, le=120000)]

# Vault token constants — these are the only placeholder strings the server
# may emit in a FILL action. The real value lives in the client vault only.
VAULT_TOKENS = frozenset({"{{NAME}}", "{{EMAIL}}", "{{PHONE}}", "{{ADDRESS}}", "{{AADHAAR}}", "{{PAN}}", "{{PASSWORD}}"})
VAULT_TOKEN_RE = re.compile(r"^\{\{[A-Z_]+\}\}$")
VaultToken = Literal["{{NAME}}", "{{EMAIL}}", "{{PHONE}}", "{{ADDRESS}}", "{{AADHAAR}}", "{{PAN}}", "{{PASSWORD}}"]


class Strict(BaseModel):
    # UUIDs arrive as canonical JSON strings; bounded numeric fields remain constrained.
    # `extra=forbid` applies recursively because every nested model inherits this class.
    model_config = ConfigDict(extra="forbid", strict=False)


class Box(Strict):
    x: I
    y: I
    width: I
    height: I


Label = Literal[
    "[PERSON_NAME]",
    "[EMAIL]",
    "[PHONE]",
    "[AADHAAR]",
    "[PAN]",
    "[PASSWORD]",
    "[ADDRESS]",
    "[PAYMENT]",
    "[PRIVATE_TEXT]",
    "[IMAGE]",
    "[PERSON_IMAGE]",
    "[TEXT_IN_IMAGE]",
    "[UNKNOWN_VISUAL]",
    "NAME",
    "EMAIL",
    "PHONE",
    "ADDRESS",
    "PASSWORD",
    "AADHAAR",
    "PAN",
    "SEARCH",
    "SUBMIT",
    "CONTINUE",
    "NEXT",
    "BACK",
    "CANCEL",
    "SAVE",
    "REVIEW",
    "CHECKBOX",
    "SELECT",
    "FIELD",
    "TEXT",
]
Role = Literal["INPUT", "BUTTON", "LINK", "TEXT", "IMAGE", "SELECT", "CHECKBOX"]
State = Literal["EMPTY", "FILLED", "AVAILABLE", "DISABLED"]


class Element(Strict):
    id: UUID
    role: Role
    label: Label
    state: State
    box: Box
    rawText: str | None = None


VisualLabel = Literal["[PERSON_IMAGE]", "[IMAGE]", "[TEXT_IN_IMAGE]", "[UNKNOWN_VISUAL]"]


class VisionRegion(Strict):
    label: VisualLabel
    box: Box


class Vision(Strict):
    status: Literal["NOT_RUN", "READY", "UNAVAILABLE"]
    backend: Literal["NONE", "WASM", "GPU"]
    durationMs: Duration
    regions: list[VisionRegion] = Field(default_factory=list, max_length=100)


class Viewport(Strict):
    width: ViewportI
    height: ViewportI


class Privacy(Strict):
    mode: Literal["SEMANTIC_ONLY", "HYBRID"]
    rawPixels: Literal[False]
    freeText: bool
    redactedPixels: str | None


class Scene(Strict):
    version: Literal["1.0"]
    requestId: UUID
    revision: UUID
    goal: Literal["REVIEW_FORM", "NEXT_STEP", "SCROLL_DOWN"]
    viewport: Viewport
    elements: list[Element] = Field(max_length=200)
    vision: Vision
    privacy: Privacy

    @field_validator("elements")
    @classmethod
    def unique_element_ids(cls, elements: list[Element]) -> list[Element]:
        ids = [element.id for element in elements]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate element id")
        return elements

    @model_validator(mode="after")
    def boxes_fit_viewport(self) -> "Scene":
        # The extension clips CSS geometry before egress; reject anything that still
        # falls outside the declared viewport rather than normalizing it server-side.
        for element in self.elements:
            box = element.box
            if box.x + box.width > self.viewport.width or box.y + box.height > self.viewport.height:
                raise ValueError("element box outside viewport")
        for region in self.vision.regions:
            box = region.box
            if box.x + box.width > self.viewport.width or box.y + box.height > self.viewport.height:
                raise ValueError("vision box outside viewport")
        return self


class Action(Strict):
    kind: Literal["FOCUS", "FILL", "CLICK", "SCROLL", "DONE"]
    target: UUID | None
    targetCoordinate: Box | None = None
    amount: Amount
    reason: Literal["EMPTY_FIELD", "NEXT_CONTROL", "USER_SCROLL", "REVIEW_REQUIRED", "NO_SAFE_ACTION"]
    # Only present on FILL actions — a {{TOKEN}} placeholder, never a real value.
    value: VaultToken | None = None

    @model_validator(mode="after")
    def fill_requires_valid_token(self) -> "Action":
        if self.kind == "FILL":
            if self.value is None or self.value not in VAULT_TOKENS:
                raise ValueError("FILL action must have a known vault token as value")
        elif self.value is not None:
            raise ValueError("value field only allowed on FILL actions")
        return self


class Plan(Strict):
    requestId: UUID
    revision: UUID
    mode: Literal["DEMO", "OLLAMA", "GEMINI", "OPENAI", "GROQ"]
    actions: list[Action] = Field(min_length=1)


class ModelPlan(Strict):
    """The only shape accepted from an Ollama-compatible model."""

    requestId: UUID
    revision: UUID
    actions: list[Action] = Field(min_length=1)


class ChatRequest(Strict):
    scene: Scene
    question: str
    token: str | None = None

