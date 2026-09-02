package blockchain

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"golang.org/x/crypto/sha3"
)

// signTx signs an Ethereum EIP-155 transaction.
// keyBytes: 32-byte raw private key.
// tx: hex strings for nonce, gasPrice, gas, to, value, data.
// Returns 0x-prefixed signed transaction hex.
func signTx(tx map[string]interface{}, keyBytes []byte, chainID int64) (string, error) {
	// Convert to btcdc key
	btcKey, pub := btcec.PrivKeyFromBytes(keyBytes)
	if btcKey == nil || pub == nil {
		return "", fmt.Errorf("invalid key bytes")
	}

	// 1. Unsigned tx RLP for Keccak256 digest
	unsignedRLP := buildRLPUnsigned(tx)
	h := sha3.NewLegacyKeccak256()
	h.Write(unsignedRLP)
	txHash := h.Sum(nil) // 32 bytes

	// 2. Sign with btcdc (RFC6979 nonce)
	sig := ecdsa.Sign(btcKey, txHash)

	// 3. Derive recID from the signer's public key's y-parity.
	// For EIP-155: v = chainId*2 + 35 + recID, where recID = y%2.
	recID := int(pub.Y().Bit(0)) // y%2

	// 4. EIP-155 v = chainId*2 + 35 + recID
	v := chainID*2 + 35 + int64(recID)

	// 5. Serialize r||s from the btcdc Signature
	sigBytes := sig.Serialize() // r||s 64 bytes
	r := sigBytes[0:32]
	s := sigBytes[32:64]

	// 6. Final signed tx RLP: [nonce,gp,gas,to,val,data,v,r,s]
	signedRLP := rlpEncodeList(
		tx["nonce"], tx["gasPrice"], tx["gas"], tx["to"], tx["value"], tx["data"],
		fmt.Sprintf("0x%x", v),
		"0x"+hex.EncodeToString(r),
		"0x"+hex.EncodeToString(s),
	)
	return "0x" + hex.EncodeToString(signedRLP), nil
}

// PubKeyToEthereumAddr returns the Ethereum address from a btcdc public key.
func PubKeyToEthereumAddr(pub *btcec.PublicKey) string {
	// Serialize uncompressed: 0x04 || X || Y
	serialized := pub.SerializeUncompressed()
	// Keccak256 hash → last 20 bytes = address
	h := sha3.NewLegacyKeccak256()
	h.Write(serialized)
	digest := h.Sum(nil)
	return "0x" + hex.EncodeToString(digest[12:])
}

// --- RLP encoding (stdlib only) ---

func buildRLPUnsigned(tx map[string]interface{}) []byte {
	return rlpEncodeList(
		tx["nonce"], tx["gasPrice"], tx["gas"], tx["to"], tx["value"], tx["data"],
	)
}

func rlpEncodeList(items ...interface{}) []byte {
	encoded := make([]byte, 0)
	for _, item := range items {
		encoded = append(encoded, rlpEncodeItem(item)...)
	}
	if len(encoded) <= 55 {
		return append([]byte{byte(0xc0 + len(encoded))}, encoded...)
	}
	return append(encodeLen(len(encoded)), encoded...)
}

func rlpEncodeItem(v interface{}) []byte {
	switch x := v.(type) {
	case string:
		s := strings.TrimPrefix(x, "0x")
		if s == "" {
			return []byte{0x80}
		}
		b, err := hex.DecodeString(s)
		if err != nil || len(b) == 0 {
			return []byte{0x80}
		}
		return rlpEncodeBytes(b)
	case int:
		if x == 0 {
			return []byte{0x80}
		}
		return rlpEncodeBytes(big.NewInt(int64(x)).Bytes())
	case int64:
		if x == 0 {
			return []byte{0x80}
		}
		return rlpEncodeBytes(big.NewInt(x).Bytes())
	default:
		return []byte{}
	}
}

func rlpEncodeBytes(b []byte) []byte {
	if len(b) == 0 {
		return []byte{0x80}
	}
	if len(b) == 1 && b[0] < 0x80 {
		return b
	}
	if len(b) <= 55 {
		return append([]byte{byte(0x80 + len(b))}, b...)
	}
	return append(encodeLen(len(b)), b...)
}

func encodeLen(length int) []byte {
	if length < 56 {
		return []byte{byte(length)}
	}
	b := big.NewInt(int64(length)).Bytes()
	return append([]byte{byte(0xb7 + len(b))}, b...)
}
