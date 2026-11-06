package format

import (
	"encoding/json"
	"errors"
	"strings"
)

var ErrInvalidToolCall = errors.New("Gemini returned a malformed tool call. No action was accepted; check the selected model and bridge version")

// Both API adapters accept arguments as an object or a JSON-encoded object.
// Reject a malformed call as a whole instead of dropping it or executing only
// the valid portion of an otherwise invalid response.
func parseFunctionCallJSON(content string) (string, map[string]any, error) {
	var data struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
		Args      json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal([]byte(content), &data); err != nil || strings.TrimSpace(data.Name) == "" {
		return "", nil, ErrInvalidToolCall
	}
	raw := data.Args
	if len(raw) == 0 {
		raw = data.Arguments
	}
	if len(raw) == 0 || string(raw) == "null" {
		return strings.TrimSpace(data.Name), map[string]any{}, nil
	}
	var encoded string
	if len(raw) > 0 && raw[0] == '"' {
		if err := json.Unmarshal(raw, &encoded); err != nil {
			return "", nil, ErrInvalidToolCall
		}
		raw = []byte(encoded)
	}
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil || args == nil {
		return "", nil, ErrInvalidToolCall
	}
	return strings.TrimSpace(data.Name), args, nil
}
