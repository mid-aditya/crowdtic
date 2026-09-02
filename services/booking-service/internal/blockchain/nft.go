package blockchain

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/btcsuite/btcd/btcec/v2"
)

// NFTClient wraps Ethereum RPC + local signing for TicketNFT interactions.
type NFTClient struct {
	rpc      *RPCClient
	addr     string // contract address 0x...
	keyBytes []byte // raw 32-byte key (passed to signTx)
	btcKey   *btcec.PrivateKey
	chainID  int64
}

// NewNFTClient initializes an NFT client.
// privKeyHex: 64-char hex private key (no 0x prefix).
func NewNFTClient(rpcURL, contractAddr, privKeyHex string, chainID int64) (*NFTClient, error) {
	keyBytes, err := hex.DecodeString(strings.TrimPrefix(privKeyHex, "0x"))
	if err != nil || len(keyBytes) != 32 {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}
	btcKey, pub := btcec.PrivKeyFromBytes(keyBytes)
	// Validate: privKey is usable
	if btcKey == nil || pub == nil {
		return nil, fmt.Errorf("invalid secp256k1 key")
	}

	return &NFTClient{
		rpc:      NewRPCClient(rpcURL),
		addr:     contractAddr,
		keyBytes: keyBytes,
		btcKey:   btcKey,
		chainID:  chainID,
	}, nil
}

// MintTicket calls TicketNFT.mintTicket after PG commit succeeds.
func (c *NFTClient) MintTicket(ctx context.Context, to string, eventID [32]byte, seatNumber uint64, faceValueWei *big.Int, kycRequired bool, metadataURI string) (txHash string, tokenID *big.Int, err error) {
	calldata := MintTicketSig(to, eventID, seatNumber, faceValueWei, kycRequired, metadataURI)
	calldataHex := "0x" + hex.EncodeToString(calldata)

	fromAddr := PubKeyToEthereumAddr(c.btcKey.PubKey())
	nonce, err := c.rpc.GetTransactionCount(ctx, fromAddr)
	if err != nil {
		return "", nil, fmt.Errorf("nonce: %w", err)
	}

	tx := map[string]interface{}{
		"to":       c.addr,
		"gas":      "0x60000",
		"gasPrice": "0x0",
		"nonce":    fmt.Sprintf("0x%x", nonce),
		"chainId":  fmt.Sprintf("0x%x", c.chainID),
		"value":    "0x0",
		"data":     calldataHex,
	}

	signed, err := signTx(tx, c.keyBytes, c.chainID)
	if err != nil {
		return "", nil, fmt.Errorf("sign: %w", err)
	}

	hash, err := c.rpc.SendRawTransaction(ctx, signed)
	if err != nil {
		return "", nil, fmt.Errorf("broadcast: %w", err)
	}

	receipt, err := c.rpc.GetTransactionReceipt(ctx, hash)
	if err != nil {
		return hash, nil, fmt.Errorf("receipt: %w", err)
	}

	tokenID = big.NewInt(0)
	for _, log := range receipt.Logs {
		if len(log.Topics) == 4 && strings.EqualFold(log.Topics[0], "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
			tokenID = hexToBigInt(log.Topics[3])
			break
		}
	}

	if receipt.Status != "0x1" {
		return hash, tokenID, fmt.Errorf("tx status %s (reverted)", receipt.Status)
	}
	return hash, tokenID, nil
}

func hexToBigInt(s string) *big.Int {
	s = strings.TrimPrefix(s, "0x")
	b, _ := hex.DecodeString(s)
	return new(big.Int).SetBytes(b)
}
