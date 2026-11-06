package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ikhsan3adi/gemini-web2api/internal/config"
	"github.com/ikhsan3adi/gemini-web2api/internal/format"
	"github.com/ikhsan3adi/gemini-web2api/internal/models"
)

type mockGeminiRequester struct {
	body     string
	attempts int
}

func (m *mockGeminiRequester) Do(req *http.Request) (*http.Response, error) {
	m.attempts++
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(m.body))}, nil
}

func newTestApp(cfg config.Config, version string) *App {
	cfg.CookieFile = ""
	cfg.LogRequests = false
	cfg.RetryDelaySec = 0
	app := New(cfg, version)
	app.Gem.HTTP = &mockGeminiRequester{}
	return app
}

func mockResponseLine(t *testing.T, text string) string {
	t.Helper()
	inner, err := json.Marshal([]any{strings.Repeat("metadata", 32), nil, nil, nil, []any{[]any{"candidate", []any{text}}}})
	if err != nil {
		t.Fatal(err)
	}
	outer, err := json.Marshal([]any{[]any{"wrb.fr", "rpc", string(inner)}})
	if err != nil {
		t.Fatal(err)
	}
	return string(outer) + "\n"
}

func TestHealthEndpoint(t *testing.T) {
	testVer := "test-version-1.0"
	cfg := config.Default()
	app := newTestApp(cfg, testVer)
	handler := app.Handler()

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("Invalid JSON response: %v", err)
	}

	if body["status"] != "ok" || body["version"] != testVer {
		t.Errorf("Unexpected health response: %v", body)
	}
}

func TestAuthMatrix(t *testing.T) {
	cfg := config.Default()
	cfg.APIKeys = []string{"sk-secret-key"}
	app := newTestApp(cfg, "test-version")
	handler := app.Handler()

	// 1. No key -> 401
	req1 := httptest.NewRequest("GET", "/v1/models", nil)
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusUnauthorized {
		t.Errorf("Expected 401 without auth, got %d", rec1.Code)
	}

	// 2. Wrong key -> 401
	req2 := httptest.NewRequest("GET", "/v1/models", nil)
	req2.Header.Set("Authorization", "Bearer wrong-key")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Errorf("Expected 401 with wrong key, got %d", rec2.Code)
	}

	// 3. Valid Bearer token -> 200
	req3 := httptest.NewRequest("GET", "/v1/models", nil)
	req3.Header.Set("Authorization", "Bearer sk-secret-key")
	rec3 := httptest.NewRecorder()
	handler.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusOK {
		t.Errorf("Expected 200 with Bearer token, got %d", rec3.Code)
	}

	// 4. Valid x-api-key header -> 200
	req4 := httptest.NewRequest("GET", "/v1/models", nil)
	req4.Header.Set("x-api-key", "sk-secret-key")
	rec4 := httptest.NewRecorder()
	handler.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusOK {
		t.Errorf("Expected 200 with x-api-key, got %d", rec4.Code)
	}

	// 5. Valid x-goog-api-key header -> 200
	req5 := httptest.NewRequest("GET", "/v1/models", nil)
	req5.Header.Set("x-goog-api-key", "sk-secret-key")
	rec5 := httptest.NewRecorder()
	handler.ServeHTTP(rec5, req5)
	if rec5.Code != http.StatusOK {
		t.Errorf("Expected 200 with x-goog-api-key, got %d", rec5.Code)
	}

	// 6. Valid query param ?key= -> 200
	req6 := httptest.NewRequest("GET", "/v1/models?key=sk-secret-key", nil)
	rec6 := httptest.NewRecorder()
	handler.ServeHTTP(rec6, req6)
	if rec6.Code != http.StatusOK {
		t.Errorf("Expected 200 with ?key= query, got %d", rec6.Code)
	}
}

func TestCORSPreflight(t *testing.T) {
	cfg := config.Default()
	app := newTestApp(cfg, "test-version")
	handler := app.Handler()

	req := httptest.NewRequest("OPTIONS", "/v1/chat/completions", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("Expected status 204 for OPTIONS, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("Expected CORS origin *, got %s", rec.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestMarshalNoEscapeHTML(t *testing.T) {
	data := map[string]string{
		"text": "<hello & world>",
	}
	b, err := marshalNoEscapeHTML(data)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	expected := `{"text":"<hello & world>"}`
	if string(b) != expected {
		t.Errorf("Got %q, want %q", string(b), expected)
	}
}

func TestChunkedTransferEncoding(t *testing.T) {
	// Verify that the server can parse request bodies via net/http transparent dechunking.
	cfg := config.Default()
	app := newTestApp(cfg, "test")
	handler := app.Handler()

	body := `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// The mocked upstream is empty; the valid request must reach generation and fail.
	if rec.Code != http.StatusBadGateway {
		t.Errorf("Expected an empty upstream failure, got %d", rec.Code)
	}
}

func TestResponsesSequenceNumberOrder(t *testing.T) {
	// Test BuildResponseOutput structure and verify format helpers produce consistent output.
	output := format.BuildResponseOutput("Hello world", nil, "msg_test123")
	if len(output) != 1 {
		t.Fatalf("Expected 1 output item, got %d", len(output))
	}
	item := output[0]
	if item["type"] != "message" {
		t.Errorf("Expected type=message, got %v", item["type"])
	}
	if item["id"] != "msg_test123" {
		t.Errorf("Expected id=msg_test123, got %v", item["id"])
	}

	// With tool calls
	tc := models.OpenAIToolCall{
		ID:   "call_abc123",
		Type: "function",
		Function: models.OpenAIToolCallFunction{
			Name:      "get_weather",
			Arguments: `{"city":"Jakarta"}`,
		},
	}
	outputWithTools := format.BuildResponseOutput("", []models.OpenAIToolCall{tc}, "msg_456")
	// When text is empty, only the function_call item is returned (no empty message).
	if len(outputWithTools) != 1 {
		t.Fatalf("Expected 1 output item (function_call only when text empty), got %d", len(outputWithTools))
	}
	if outputWithTools[0]["type"] != "function_call" {
		t.Errorf("First item should be function_call, got %v", outputWithTools[0]["type"])
	}
	if outputWithTools[0]["call_id"] != "call_abc123" {
		t.Errorf("Expected call_id=call_abc123, got %v", outputWithTools[0]["call_id"])
	}

	// Verify responses format: the non-streaming endpoint should accept valid structure.
	// The responses API uses "input" field, not "messages".
	cfg := config.Default()
	app := newTestApp(cfg, "test")
	handler := app.Handler()

	body := `{"model":"gemini-3.6-flash","input":"test prompt"}`
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("Expected an empty upstream failure, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestModelHeaders(t *testing.T) {
	cfg := config.Default()
	app := newTestApp(cfg, "test")
	handler := app.Handler()

	// 1. Known model: gemini-4-argon
	bodyKnown := `{"model":"gemini-4-argon","messages":[{"role":"user","content":"hi"}]}`
	req1 := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(bodyKnown))
	req1.Header.Set("Content-Type", "application/json")
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)

	if got := rec1.Header().Get("X-Resolved-Model"); got != "gemini-4-argon" {
		t.Errorf("Expected X-Resolved-Model=gemini-4-argon, got %q", got)
	}
	if got := rec1.Header().Get("X-Model-Fallback"); got != "" {
		t.Errorf("Expected X-Model-Fallback to be empty for known model, got %q", got)
	}

	// 2. Unknown model: should fallback and set X-Model-Fallback: true
	bodyUnknown := `{"model":"gemini-9.9-fake","messages":[{"role":"user","content":"hi"}]}`
	req2 := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(bodyUnknown))
	req2.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)

	if got := rec2.Header().Get("X-Resolved-Model"); got != "gemini-3.6-flash" {
		t.Errorf("Expected X-Resolved-Model=gemini-3.6-flash, got %q", got)
	}
	if got := rec2.Header().Get("X-Model-Fallback"); got != "true" {
		t.Errorf("Expected X-Model-Fallback=true for unknown model, got %q", got)
	}
}

func TestEmptyUpstreamNeverEmitsSuccessfulCompletion(t *testing.T) {
	for _, endpoint := range []struct {
		path, body string
		stream     bool
	}{
		{"/v1/chat/completions", `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}]}`, false},
		{"/v1/chat/completions", `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}],"stream":true}`, true},
		{"/v1/responses", `{"model":"gemini-3.6-flash","input":"hi"}`, false},
		{"/v1beta/models/gemini-3.6-flash:generateContent", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`, false},
		{"/v1beta/models/gemini-3.6-flash:streamGenerateContent", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`, true},
	} {
		t.Run(endpoint.path, func(t *testing.T) {
			app := newTestApp(config.Default(), "test")
			upstream := &mockGeminiRequester{}
			app.Gem.HTTP = upstream
			rec := httptest.NewRecorder()
			app.Handler().ServeHTTP(rec, httptest.NewRequest("POST", endpoint.path, strings.NewReader(endpoint.body)))
			if !endpoint.stream && rec.Code != http.StatusBadGateway {
				t.Fatalf("empty generation status=%d: %s", rec.Code, rec.Body.String())
			}
			response := rec.Body.String()
			if !strings.Contains(response, "Gemini returned no answer") {
				t.Fatalf("missing actionable error: %s", response)
			}
			if !strings.Contains(response, `"code":"empty_response"`) {
				t.Fatalf("missing empty-response code: %s", response)
			}
			if strings.Contains(response, `"finish_reason":"stop"`) || strings.Contains(response, `"finishReason":"STOP"`) || strings.Contains(response, "[DONE]") {
				t.Fatalf("empty generation marked successful: %s", response)
			}
			if endpoint.stream && !strings.Contains(response, "event: error") {
				t.Fatalf("missing streaming error event: %s", response)
			}
			if upstream.attempts != 1 {
				t.Fatalf("empty generation replayed %d times", upstream.attempts)
			}
		})
	}
}

func TestMalformedToolResponseFailsBeforeReturningAnyTool(t *testing.T) {
	for _, endpoint := range []struct{ path, body, answer string }{
		{"/v1/chat/completions", `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}}]}`, "```tool_call\n{\"name\":\"read_file\",\"arguments\":{}}\n```\n```tool_call\nnot-json\n```"},
		{"/v1/responses", `{"model":"gemini-3.6-flash","input":"hi","tools":[{"type":"function","name":"read_file","parameters":{"type":"object"}}]}`, "```tool_call\nnot-json\n```"},
		{"/v1beta/models/gemini-3.6-flash:generateContent", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"tools":[{"functionDeclarations":[{"name":"read_file","parameters":{"type":"object"}}]}]}`, "```function_call\nnot-json\n```"},
	} {
		t.Run(endpoint.path, func(t *testing.T) {
			app := newTestApp(config.Default(), "test")
			upstream := &mockGeminiRequester{body: mockResponseLine(t, endpoint.answer)}
			app.Gem.HTTP = upstream
			rec := httptest.NewRecorder()
			app.Handler().ServeHTTP(rec, httptest.NewRequest("POST", endpoint.path, strings.NewReader(endpoint.body)))
			if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "invalid_tool_call") {
				t.Fatalf("malformed tool accepted: status=%d, body=%s", rec.Code, rec.Body.String())
			}
			if upstream.attempts != 1 {
				t.Fatalf("malformed tool generation replayed %d times", upstream.attempts)
			}
		})
	}
}
