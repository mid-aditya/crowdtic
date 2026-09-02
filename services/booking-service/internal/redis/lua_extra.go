package rlua

import (
	"encoding/json"
	"fmt"
)

func ParseReply(raw interface{}) (map[string]interface{}, error) {
	if raw == nil {
		return map[string]interface{}{}, nil
	}
	if m, ok := raw.(map[string]interface{}); ok {
		return m, nil
	}
	if s, ok := raw.(string); ok {
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(s), &m); err == nil {
			return m, nil
		}
		return map[string]interface{}{"raw": s}, nil
	}
	return map[string]interface{}{"raw": fmt.Sprintf("%v", raw)}, nil
}
