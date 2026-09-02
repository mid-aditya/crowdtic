package broker

import "github.com/nats-io/nats.go"

type Publisher interface {
	PublishAsync(subject string, data []byte) error
}

type NATSPublisher struct{ Conn *nats.Conn }

func (p *NATSPublisher) PublishAsync(subject string, data []byte) error {
	if p.Conn == nil {
		return nil
	}
	return p.Conn.Publish(subject, data)
}
