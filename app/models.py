from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


# --- Part Models ---


class TokenUsage(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    input: Optional[int] = 0
    output: Optional[int] = 0
    cache: Optional[Dict[str, int]] = None


class GenericPart(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="allow")

    id: Optional[str] = None
    type: str
    text: Optional[str] = None
    tool: Optional[str] = None
    state: Optional[Dict[str, Any]] = None
    tokens: Optional[TokenUsage] = None
    time_created: Optional[int] = None
    synthetic: Optional[bool] = None  # True for auto-generated parts (tool call echoes)


# --- Message Models ---


class MessageSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    title: Optional[str] = None
    diffs: Optional[List[Any]] = None


class ModelInfo(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    providerID: Optional[str] = None
    modelID: Optional[str] = None


class Message(BaseModel):
    id: Optional[str] = None
    role: str
    agent: Optional[str] = None
    model: Optional[Union[ModelInfo, str]] = None
    modelID: Optional[str] = None  # Legacy/Flat support
    time_created: Optional[int] = None
    time_updated: Optional[int] = None
    summary: Optional[MessageSummary] = None
    parts: List[GenericPart] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)

    @property
    def model_name(self) -> str:
        if isinstance(self.model, ModelInfo) and self.model.modelID:
            return self.model.modelID
        if self.modelID:
            return self.modelID
        if isinstance(self.model, str):
            return self.model
        return "Unknown"


# --- Conversation Models ---


class ConversationSummary(BaseModel):
    """Used for listing conversations."""

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    title: Optional[str] = None
    directory: Optional[str] = None
    version: Optional[str] = None
    project_id: Optional[str] = Field(None, alias="projectID")
    parent_id: Optional[str] = None

    # Flattened time
    time_created: Optional[int] = None
    time_updated: Optional[int] = None

    # Flattened summary stats
    summary_additions: Optional[int] = 0
    summary_deletions: Optional[int] = 0
    summary_files: Optional[int] = 0

    model: Optional[str] = "Unknown"

    # User-defined extensions (None when not set)
    slug: Optional[str] = None


class ConversationExport(BaseModel):
    """Full conversation export."""

    summary: ConversationSummary
    messages: List[Message]


# --- Search Models ---


class SearchMatch(BaseModel):
    """A single search match within a conversation."""

    part_id: str
    message_id: str
    role: str
    snippet: str  # Text snippet with match context
    time_created: Optional[int] = None


class SearchResult(BaseModel):
    """Search result for a conversation."""

    conversation_id: str
    title: Optional[str] = None
    directory: Optional[str] = None
    time_updated: Optional[int] = None
    matches: List[SearchMatch] = Field(default_factory=list)
    total_matches: int = 0
