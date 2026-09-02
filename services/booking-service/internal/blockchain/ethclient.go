package blockchain

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// RPCClient is a minimal JSON-RPC 2.0 Ethereum client.
// No external ethereum libs — stdlib only.
type RPCClient struct {
	url        string
	httpClient *http.Client
}

func NewRPCClient(rpcURL string) *RPCClient {
	return &RPCClient{
		url: rpcURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        10,
				IdleConnTimeout:     90 * time.Second,
				TLSHandshakeTimeout: 10 * time.Second,
			},
		},
	}
}

// rpcReq builds and sends a JSON-RPC request.
func (c *RPCClient) rpcCall(ctx context.Context, method string, args, result interface{}) error {
	type rpcReq struct {
		JSONRPC string        `json:"jsonrpc"`
		Method  string        `json:"method"`
		Params  []interface{} `json:"params"`
		ID      int           `json:"id"`
	}
	params, ok := args.([]interface{})
	if !ok {
		return fmt.Errorf("params must be []interface{}")
	}
	payload, err := json.Marshal(rpcReq{JSONRPC: "2.0", Method: method, Params: params, ID: 1})
	if err != nil {
		return fmt.Errorf("json marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("rpc %s http %d: %s", method, resp.StatusCode, string(b))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}

	// Strip JSON-RPC error wrapper
	var rpcResp struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  json.RawMessage `json:"result,omitempty"`
		Error   *rpcError       `json:"error,omitempty"`
	}
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return fmt.Errorf("unmarshal response: %w", err)
	}
	if rpcResp.Error != nil {
		return fmt.Errorf("rpc error %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	if result != nil && len(rpcResp.Result) > 0 {
		if err := json.Unmarshal(rpcResp.Result, result); err != nil {
			return fmt.Errorf("unmarshal result: %w", err)
		}
	}
	return nil
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ChainID returns the network chain ID.
func (c *RPCClient) ChainID(ctx context.Context) (int64, error) {
	var id string
	if err := c.rpcCall(ctx, "eth_chainId", nil, &id); err != nil {
		return 0, err
	}
	return parseHexInt64(id)
}

// GetTransactionCount returns the next nonce for an address.
func (c *RPCClient) GetTransactionCount(ctx context.Context, addr string) (uint64, error) {
	var nonce string
	if err := c.rpcCall(ctx, "eth_getTransactionCount", []interface{}{addr, "pending"}, &nonce); err != nil {
		return 0, err
	}
	return parseHexUint64(nonce)
}

// SendRawTransaction broadcasts a signed transaction.
func (c *RPCClient) SendRawTransaction(ctx context.Context, signedTx string) (txHash string, err error) {
	err = c.rpcCall(ctx, "eth_sendRawTransaction", []interface{}{signedTx}, &txHash)
	return
}

// Call executes a read-only call.
func (c *RPCClient) Call(ctx context.Context, to, data string) (string, error) {
	type ethCallReq struct {
		To   string `json:"to"`
		Data string `json:"data"`
	}
	var result string
	err := c.rpcCall(ctx, "eth_call", []interface{}{ethCallReq{To: to, Data: data}, "latest"}, &result)
	return result, err
}

// TxReceipt represents an eth_getTransactionReceipt result.
type TxReceipt struct {
	TxHash      string `json:"transactionHash"`
	BlockNumber string `json:"blockNumber"`
	Status      string `json:"status"`
	Logs        []struct {
		Address string   `json:"address"`
		Topics  []string `json:"topics"`
		Data    string   `json:"data"`
	} `json:"logs"`
}

// GetTransactionReceipt polls until the receipt is available.
func (c *RPCClient) GetTransactionReceipt(ctx context.Context, txHash string) (*TxReceipt, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(2 * time.Minute)
	}
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			var r TxReceipt
			if err := c.rpcCall(ctx, "eth_getTransactionReceipt", []interface{}{txHash}, &r); err != nil {
				return nil, err
			}
			if r.BlockNumber != "" {
				return &r, nil
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("tx receipt timeout for %s", txHash)
		}
	}
}
