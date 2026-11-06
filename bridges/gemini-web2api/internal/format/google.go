package format

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/ikhsan3adi/gemini-web2api/internal/models"
)

type Image struct {
	Data []byte
	MIME string
	URL  string // Remote URL passthrough (when data not yet fetched)
}

func BuildToolPrompt(defs []models.GoogleFunctionDeclaration) string {
	specBytes, _ := json.Marshal(defs)
	// Tool slimming: if tool definitions exceed 30KB, re-marshal with name+description only.
	if len(specBytes) > 30000 {
		slimmed := make([]models.GoogleFunctionDeclaration, len(defs))
		for i, d := range defs {
			slimmed[i] = models.GoogleFunctionDeclaration{
				Name:        d.Name,
				Description: d.Description,
			}
		}
		specBytes, _ = json.Marshal(slimmed)
	}
	return fmt.Sprintf(
		"# Tool Use\n\n"+
			"You can call the following tools to help accomplish tasks. "+
			"These tools connect to the user's local environment and will execute when called.\n\n"+
			"Call format (use this exact format):\n"+
			"```function_call\n"+
			"{\"name\": \"<tool_name>\", \"args\": {<arguments>}}\n"+
			"```\n\n"+
			"When calling tools:\n"+
			"- Output ONLY the function_call block(s), nothing else\n"+
			"- You may call multiple tools with multiple blocks\n"+
			"- After receiving a [Tool result for ...], use that data to answer the user\n\n"+
			"Available tools:\n%s",
		string(specBytes),
	)
}

func GoogleToolChoiceInstruction(req models.GoogleGenerateRequest) string {
	mode := "AUTO"
	if req.ToolConfig != nil && req.ToolConfig.FunctionCallingConfig != nil {
		if req.ToolConfig.FunctionCallingConfig.Mode != "" {
			mode = req.ToolConfig.FunctionCallingConfig.Mode
		}
	}

	if mode == "NONE" {
		return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only."
	}
	if mode == "ANY" {
		if req.ToolConfig != nil && req.ToolConfig.FunctionCallingConfig != nil && len(req.ToolConfig.FunctionCallingConfig.AllowedFunctionNames) > 0 {
			var names []string
			for _, s := range req.ToolConfig.FunctionCallingConfig.AllowedFunctionNames {
				names = append(names, fmt.Sprintf("\"%s\"", s))
			}
			if len(names) > 0 {
				return fmt.Sprintf("\n\nIMPORTANT: You MUST call one of these tools: %s. Do not respond with text only.", strings.Join(names, ", "))
			}
		}
		return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only."
	}
	return ""
}

func GoogleContentsToPrompt(req models.GoogleGenerateRequest) (string, []Image, error) {
	var parts []string
	var images []Image

	fcMode := "AUTO"
	if req.ToolConfig != nil && req.ToolConfig.FunctionCallingConfig != nil && req.ToolConfig.FunctionCallingConfig.Mode != "" {
		fcMode = req.ToolConfig.FunctionCallingConfig.Mode
	}

	var toolDefs []models.GoogleFunctionDeclaration
	if fcMode != "NONE" {
		for _, toolGroup := range req.Tools {
			toolDefs = append(toolDefs, toolGroup.FunctionDeclarations...)
		}
	}

	var sysText string
	if req.SystemInstruction != nil {
		var tParts []string
		for _, p := range req.SystemInstruction.Parts {
			if p.Text != "" {
				tParts = append(tParts, p.Text)
			}
		}
		sysText = strings.Join(tParts, " ")
	}

	if sysText != "" {
		if len(toolDefs) > 0 {
			constraint := GoogleToolChoiceInstruction(req)
			parts = append(parts, sysText+"\n\n"+BuildToolPrompt(toolDefs)+constraint)
		} else {
			parts = append(parts, sysText)
		}
	} else if len(toolDefs) > 0 {
		constraint := GoogleToolChoiceInstruction(req)
		parts = append(parts, BuildToolPrompt(toolDefs)+constraint)
	}

	for _, content := range req.Contents {
		role := content.Role
		if role == "" {
			role = "user"
		}

		var msgParts []string
		for _, p := range content.Parts {
			if p.Text != "" {
				msgParts = append(msgParts, p.Text)
			} else if p.InlineData != nil {
				mime := p.InlineData.MIMEType
				if mime == "" {
					mime = "image/png"
				}
				if dec, err := base64.StdEncoding.DecodeString(p.InlineData.Data); err == nil {
					images = append(images, Image{Data: dec, MIME: mime})
					msgParts = append(msgParts, "[Image attached]")
				}
			} else if p.FunctionCall != nil {
				args := p.FunctionCall.Args
				if args == nil {
					args = map[string]any{}
				}
				payload, _ := json.Marshal(map[string]any{"name": p.FunctionCall.Name, "args": args})
				msgParts = append(msgParts, fmt.Sprintf("```function_call\n%s\n```", string(payload)))
			} else if p.FunctionResponse != nil {
				resp := p.FunctionResponse.Response
				if resp == nil {
					resp = map[string]any{}
				}
				payload, _ := json.Marshal(resp)
				msgParts = append(msgParts, fmt.Sprintf("[Tool result for %s]: %s", p.FunctionResponse.Name, string(payload)))
			}
		}

		text := strings.Join(msgParts, "\n")
		if role == "model" {
			parts = append(parts, fmt.Sprintf("[Assistant]: %s", text))
		} else {
			parts = append(parts, text)
		}
	}

	return strings.Join(parts, "\n\n"), images, nil
}

var (
	reFencedGoogleCall   = regexp.MustCompile(`(?s)\x60\x60\x60function_call\s*\n(.*?)\n\x60\x60\x60`)
	reGoogleCallStart    = regexp.MustCompile(`\x60\x60\x60function_call\b`)
	reUnfencedGoogleCall = regexp.MustCompile(`(?m)^[ \t]*function_call[ \t]*\r?\n`)
)

func ParseGoogleFunctionCalls(text string) (string, []models.GoogleFunctionCall, error) {
	var calls []models.GoogleFunctionCall
	clean := text
	matches := reFencedGoogleCall.FindAllStringSubmatch(clean, -1)
	if len(reGoogleCallStart.FindAllStringIndex(clean, -1)) != len(matches) {
		return text, nil, ErrInvalidToolCall
	}
	for _, m := range matches {
		name, args, err := parseFunctionCallJSON(strings.TrimSpace(m[1]))
		if err != nil {
			return text, nil, err
		}
		calls = append(calls, models.GoogleFunctionCall{Name: name, Args: args})
	}
	clean = strings.TrimSpace(reFencedGoogleCall.ReplaceAllString(clean, ""))

	// Decode the complete JSON value so nested arguments are not truncated at
	// the first closing brace. Keep any prose following the value.
	var cleanParts []string
	lastEnd := 0
	for _, m := range reUnfencedGoogleCall.FindAllStringIndex(clean, -1) {
		if m[0] < lastEnd {
			return text, nil, ErrInvalidToolCall
		}
		decoder := json.NewDecoder(strings.NewReader(clean[m[1]:]))
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return text, nil, ErrInvalidToolCall
		}
		name, args, err := parseFunctionCallJSON(string(raw))
		if err != nil {
			return text, nil, err
		}
		calls = append(calls, models.GoogleFunctionCall{Name: name, Args: args})
		cleanParts = append(cleanParts, clean[lastEnd:m[0]])
		lastEnd = m[1] + int(decoder.InputOffset())
	}
	cleanParts = append(cleanParts, clean[lastEnd:])
	clean = strings.TrimSpace(strings.Join(cleanParts, ""))

	if len(calls) == 0 && strings.HasPrefix(strings.TrimSpace(clean), "{") {
		var data map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(clean)), &data); err == nil {
			_, hasName := data["name"]
			_, hasArgs := data["args"]
			_, hasArguments := data["arguments"]
			if hasName && (hasArgs || hasArguments) {
				name, args, err := parseFunctionCallJSON(clean)
				if err != nil {
					return text, nil, err
				}
				calls = append(calls, models.GoogleFunctionCall{Name: name, Args: args})
				clean = ""
			}
		}
	}

	return clean, calls, nil
}
