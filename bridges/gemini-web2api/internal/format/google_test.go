package format

import (
	"errors"
	"testing"
)

func TestParseGoogleFunctionCallsRejectsMalformedBatch(t *testing.T) {
	valid := "```function_call\n{\"name\":\"read_file\",\"args\":{}}\n```\n"
	for _, invalid := range []string{
		"```function_call\nnot-json\n```",
		"```function_call\n{\"args\":{}}\n```",
		"```function_call\n{\"name\":\"run_command\",\"args\":[]}\n```",
		"```function_call\n{\"name\":\"run_command\",\"args\":{}}",
		"function_call\n{\"name\":\"run_command\",\"args\":\"not-json\"}",
	} {
		input := valid + invalid
		clean, calls, err := ParseGoogleFunctionCalls(input)
		if !errors.Is(err, ErrInvalidToolCall) || clean != input || len(calls) != 0 {
			t.Fatalf("malformed batch partially accepted: clean=%q, calls=%v, error=%v", clean, calls, err)
		}
	}
}

func TestParseGoogleFunctionCallsAcceptsNestedUnfencedArguments(t *testing.T) {
	input := "Before\nfunction_call\n{\"name\":\"read_file\",\"args\":{\"nested\":{\"path\":\"a.txt\"}}}\nAfter"
	clean, calls, err := ParseGoogleFunctionCalls(input)
	if err != nil || len(calls) != 1 || clean != "Before\n\nAfter" {
		t.Fatalf("nested arguments truncated: clean=%q, calls=%v, error=%v", clean, calls, err)
	}
	if calls[0].Args["nested"].(map[string]any)["path"] != "a.txt" {
		t.Fatalf("nested argument lost: %v", calls)
	}
}

func TestParseGoogleFunctionCallsAcceptsToolOnlyJSON(t *testing.T) {
	clean, calls, err := ParseGoogleFunctionCalls(`{"name":"read_file","arguments":{"path":"a.txt"}}`)
	if err != nil || clean != "" || len(calls) != 1 || calls[0].Args["path"] != "a.txt" {
		t.Fatalf("tool-only JSON rejected: clean=%q, calls=%v, error=%v", clean, calls, err)
	}
}

func TestParseGoogleFunctionCallsRejectsMalformedToolJSON(t *testing.T) {
	input := `{"name":"read_file","arguments":[]}`
	clean, calls, err := ParseGoogleFunctionCalls(input)
	if !errors.Is(err, ErrInvalidToolCall) || clean != input || len(calls) != 0 {
		t.Fatalf("malformed tool JSON accepted: clean=%q, calls=%v, error=%v", clean, calls, err)
	}
}
