package shipping

import (
	"errors"
	"fmt"
	"strings"
)

type Address struct {
	CountryCode string
	City        string
	PostalCode  string
	Street      string
}

type Order struct {
	ID            string
	SubtotalCents int
	WeightGrams   int
	Destination   Address
}

type ShippingQuote struct {
	Service       string
	PriceCents    int
	EstimatedDays int
}

func (order Order) QualifiesForFreeShipping(minimumCents int) bool {
	return order.SubtotalCents > minimumCents
}

func (address Address) Validate() error {
	if len(strings.TrimSpace(address.CountryCode)) != 2 {
		return errors.New("country code must contain two letters")
	}
	if strings.TrimSpace(address.City) == "" {
		return errors.New("city is required")
	}
	if strings.TrimSpace(address.Street) == "" {
		return errors.New("street is required")
	}
	if strings.TrimSpace(address.PostalCode) == "" {
		return errors.New("postal code is required")
	}
	return nil
}

func Quote(order Order, minimumCents int) (ShippingQuote, error) {
	if err := order.Destination.Validate(); err != nil {
		return ShippingQuote{}, err
	}
	if order.WeightGrams < 1 {
		return ShippingQuote{}, errors.New("weight must be positive")
	}
	price := 499
	if order.WeightGrams > 2000 {
		price += ((order.WeightGrams - 2000 + 999) / 1000) * 100
	}
	if order.QualifiesForFreeShipping(minimumCents) {
		price = 0
	}
	return ShippingQuote{
		Service:       "standard",
		PriceCents:    price,
		EstimatedDays: 4,
	}, nil
}

func FormatLabel(order Order) string {
	address := order.Destination
	return fmt.Sprintf("%s\n%s\n%s %s\n%s", order.ID, address.Street,
		address.PostalCode, address.City, strings.ToUpper(address.CountryCode))
}

func NormalizeAddress(address Address) Address {
	return Address{
		CountryCode: strings.ToUpper(strings.TrimSpace(address.CountryCode)),
		City:        strings.TrimSpace(address.City),
		PostalCode:  strings.TrimSpace(address.PostalCode),
		Street:      strings.TrimSpace(address.Street),
	}
}

func SplitPackages(totalWeightGrams, maximumWeightGrams int) ([]int, error) {
	if totalWeightGrams < 1 || maximumWeightGrams < 1 {
		return nil, errors.New("weights must be positive")
	}
	weights := []int{}
	for totalWeightGrams > 0 {
		weight := min(totalWeightGrams, maximumWeightGrams)
		weights = append(weights, weight)
		totalWeightGrams -= weight
	}
	return weights, nil
}
