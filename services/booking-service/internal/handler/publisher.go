package handler

// Publisher is implemented by broker.NATSPublisher; defined here to avoid import cycle.
type Publisher interface {
	PublishAsync(subject string, data []byte) error
}
