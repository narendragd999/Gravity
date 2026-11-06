package gemini

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/ikhsan3adi/gemini-web2api/internal/config"
)

type generationRequester struct {
	body     string
	attempts int
}

func (r *generationRequester) Do(req *http.Request) (*http.Response, error) {
	r.attempts++
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(r.body))}, nil
}

func generationClient(r *generationRequester) *Client {
	cfg := config.Default()
	cfg.RetryAttempts = 3
	cfg.RetryDelaySec = 0
	cfg.LogRequests = false
	c := NewClient(cfg)
	c.HTTP = r
	return c
}

func TestGenerateDoesNotReplayAnEmptyResponse(t *testing.T) {
	for _, raw := range []string{"", "unrecognized response", responseLine(t, " \n\t"), responseLine(t, "http://googleusercontent.com/card_content/1\n")} {
		r := &generationRequester{body: raw}
		text, err := generationClient(r).Generate("one request", ModelOptions{}, nil)
		if text != "" || !errors.Is(err, ErrEmptyResponse) {
			t.Fatalf("text=%q, error=%v", text, err)
		}
		if r.attempts != 1 {
			t.Fatalf("empty completion replayed %d times", r.attempts)
		}
	}
}

func TestGenerateStreamDoesNotReplayAnEmptyResponse(t *testing.T) {
	for _, raw := range []string{"", "unrecognized response\n", responseLine(t, " \n\t") + "\n"} {
		r := &generationRequester{body: raw}
		var emitted strings.Builder
		err := generationClient(r).GenerateStream("one request", ModelOptions{}, nil, func(delta string) error { emitted.WriteString(delta); return nil })
		if !errors.Is(err, ErrEmptyResponse) || strings.TrimSpace(emitted.String()) != "" {
			t.Fatalf("answer=%q, error=%v", emitted.String(), err)
		}
		if r.attempts != 1 {
			t.Fatalf("empty stream replayed %d times", r.attempts)
		}
	}
}

func TestStreamAttemptAcceptsFinalJSONLineWithoutNewline(t *testing.T) {
	var answer strings.Builder
	c := &Client{}
	err := c.streamAttempt(strings.NewReader(responseLine(t, "Hello")+"\n"+responseLine(t, "Hello world.")), NewStreamParser(), func(delta string) error {
		answer.WriteString(delta)
		return nil
	})
	if err != nil || answer.String() != "Hello world." {
		t.Fatalf("answer=%q, error=%v", answer.String(), err)
	}
}

func TestStreamAttemptPreservesAlreadyEmittedPrefixAcrossRetry(t *testing.T) {
	parser := NewStreamParser()
	var answer strings.Builder
	emit := func(delta string) error { answer.WriteString(delta); return nil }
	c := &Client{}
	if err := c.streamAttempt(strings.NewReader(responseLine(t, "Hello")+"\n"), parser, emit); err != nil {
		t.Fatal(err)
	}
	parser.ResetBuffer()
	if err := c.streamAttempt(strings.NewReader(responseLine(t, "Hello")+"\n"+responseLine(t, "Hello world.")+"\n"), parser, emit); err != nil {
		t.Fatal(err)
	}
	if answer.String() != "Hello world." {
		t.Fatalf("prefix repeated: %q", answer.String())
	}
}

func TestStreamAttemptPropagatesClientFailure(t *testing.T) {
	failure := errors.New("client disconnected")
	err := (&Client{}).streamAttempt(strings.NewReader(responseLine(t, "Answer")+"\n"), NewStreamParser(), func(string) error { return failure })
	if !errors.Is(err, failure) {
		t.Fatalf("client failure lost: %v", err)
	}
}

func TestStreamAttemptRejectsEmptyRetryAfterPriorAnswer(t *testing.T) {
	parser := NewStreamParser()
	c := &Client{}
	if err := c.streamAttempt(strings.NewReader(responseLine(t, "Prior prefix")+"\n"), parser, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	parser.ResetBuffer()
	err := c.streamAttempt(strings.NewReader("metadata only\n"), parser, func(string) error { return nil })
	if !errors.Is(err, ErrEmptyResponse) {
		t.Fatalf("empty retry treated prior answer as success: %v", err)
	}
}

func TestStreamAttemptRejectsOnlyCleanedMetadata(t *testing.T) {
	metadata := "```python?code_reference&code_event_index=1\nprint('hi')```\n"
	err := (&Client{}).streamAttempt(strings.NewReader(responseLine(t, metadata)+"\n"), NewStreamParser(), func(string) error { return nil })
	if !errors.Is(err, ErrEmptyResponse) {
		t.Fatalf("metadata accepted as an answer: %v", err)
	}
}

func TestDisabledRetriesStillAttemptAndRejectEmptyGeneration(t *testing.T) {
	for _, retryAttempts := range []int{0, -1} {
		for _, stream := range []bool{false, true} {
			r := &generationRequester{}
			c := generationClient(r)
			c.Cfg.RetryAttempts = retryAttempts
			var err error
			if stream {
				err = c.GenerateStream("one request", ModelOptions{}, nil, func(string) error { return nil })
			} else {
				_, err = c.Generate("one request", ModelOptions{}, nil)
			}
			if r.attempts != 1 || !errors.Is(err, ErrEmptyResponse) {
				t.Fatalf("retries=%d stream=%t: attempts=%d, error=%v", retryAttempts, stream, r.attempts, err)
			}
		}
	}
}
