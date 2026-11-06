package gemini

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestCleanText(t *testing.T) {
	input := "Hello world\n```python?code_reference&code_event_index=1\nprint('hi')```\nhttp://googleusercontent.com/card_content/123\nExtra text"
	cleaned := CleanText(input, true)
	expected := "Hello world\nExtra text"
	if cleaned != expected {
		t.Errorf("CleanText got %q, want %q", cleaned, expected)
	}
}

// Match the upstream envelope without credentials or network access. Padding
// represents unrelated metadata, including in a response containing no answer.
func responseLine(t *testing.T, text string) string {
	t.Helper()
	inner, err := json.Marshal([]any{strings.Repeat("metadata", 32), nil, nil, nil, []any{[]any{"candidate", []any{text}}}})
	if err != nil {
		t.Fatal(err)
	}
	outer, err := json.Marshal([]any{[]any{"wrb.fr", "rpc", string(inner)}})
	if err != nil {
		t.Fatal(err)
	}
	return string(outer)
}

func TestExtractResponseTextRejectsEmptyAnswers(t *testing.T) {
	for _, raw := range []string{"", "not-json", `[["wrb.fr","rpc","[]"]]`, responseLine(t, " \n\t"),
		responseLine(t, "http://googleusercontent.com/card_content/123\n"),
		responseLine(t, "```python?code_reference&code_event_index=1\nprint('hi')```\n")} {
		text, err := ExtractResponseText(raw)
		if text != "" || !errors.Is(err, ErrEmptyResponse) {
			t.Errorf("empty answer accepted: text=%q, error=%v", text, err)
		}
	}
}

func TestExtractResponseTextKeepsTheCompletedAnswer(t *testing.T) {
	raw := responseLine(t, "Hello") + "\n" + responseLine(t, "Hello world.") + "\n"
	text, err := ExtractResponseText(raw)
	if err != nil || text != "Hello world." {
		t.Fatalf("answer=%q, error=%v", text, err)
	}
}

func TestExtractResponseTextRejectsBardError(t *testing.T) {
	text, err := ExtractResponseText(responseLine(t, "Partial") + "\nBardErrorInfo [1024]")
	if text != "" || err == nil || errors.Is(err, ErrEmptyResponse) {
		t.Fatalf("Bard error accepted: text=%q, error=%v", text, err)
	}
}

func TestIsBardError(t *testing.T) {
	raw := "something BardErrorInfo [1024] happened"
	code, ok := IsBardError(raw)
	if !ok || code != "1024" {
		t.Errorf("IsBardError got (%q, %t), want (\"1024\", true)", code, ok)
	}
}
