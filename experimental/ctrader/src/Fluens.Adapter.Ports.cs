// ===========================================================================
//  CTRADERADAPTER001 — PUERTOS (capa sin SDK)
//  ---------------------------------------------------------------------------
//  Frontera entre la plataforma (cTrader) y el kernel del adaptador.
//
//  REGLA DE ORO: este archivo NO referencia cAlgo.API ni ningún tipo del SDK.
//  Solo primitivos, decimal, string y enums propios. El binding real al SDK
//  (Fase D) implementará estas interfaces; el kernel jamás verá cTrader.
//
//  Esto respeta el invariante del diseño unit005:
//      SAFETY_KERNEL_HAS_NO_RUNTIME_ADAPTER_DEPENDENCY
//      RUNTIME_EFFECTS_ONLY_IN_ADAPTER
//
//  Estado: BORRADOR NO APROBADO. Ningún veredicto autoriza este artefacto.
// ===========================================================================

using System;

namespace Fluens.LocalDemo.Adapter.Ports
{
    /// <summary>Barra cruda tal como la entrega la plataforma, ya despojada de tipos del SDK.</summary>
    public sealed class PlatformBar
    {
        public PlatformBar(long openTimeUnixSeconds, double close, bool closedByPlatform)
        {
            OpenTimeUnixSeconds = openTimeUnixSeconds;
            Close = close;
            ClosedByPlatform = closedByPlatform;
        }

        /// <summary>Apertura de la barra en segundos UNIX UTC. El binding es quien
        /// convierte DateTime -> UNIX y quien debe demostrar que es UTC real.</summary>
        public long OpenTimeUnixSeconds { get; private set; }

        public double Close { get; private set; }

        /// <summary>La plataforma afirma que la barra está cerrada. La barra en curso
        /// NUNCA debe llegar con este valor en true.</summary>
        public bool ClosedByPlatform { get; private set; }
    }

    /// <summary>Posición observada en la plataforma, sin datos de cuenta ni dinero.</summary>
    public sealed class PlatformPosition
    {
        public PlatformPosition(int id, string label, string symbolRawName, bool hasStopLoss)
        {
            Id = id;
            Label = label;
            SymbolRawName = symbolRawName;
            HasStopLoss = hasStopLoss;
        }

        public int Id { get; private set; }
        public string Label { get; private set; }
        public string SymbolRawName { get; private set; }
        public bool HasStopLoss { get; private set; }
    }

    /// <summary>
    /// Foto inmutable del estado de plataforma en un instante.
    /// Cada campo "Readable" separa "sé que es falso" de "no lo pude leer".
    /// Esa distinción es la que permite fallar cerrado en vez de asumir.
    /// </summary>
    public sealed class PlatformSnapshot
    {
        public PlatformSnapshot()
        {
            SymbolRawName = string.Empty;
            AttributablePositions = new PlatformPosition[0];
            UnattributablePositions = new PlatformPosition[0];
        }

        // --- Entorno anfitrión ---
        public bool EnvironmentReadable { get; set; }
        /// <summary>0 = DESKTOP, 1 = NON_DESKTOP, 2 = UNKNOWN. Se mapea al enum del core.</summary>
        public int EnvironmentKindRaw { get; set; }
        public bool LocalVisibleSession { get; set; }
        public bool RealTimeMode { get; set; }

        // --- Cuenta (nunca se persiste ni se expone el número) ---
        public bool AccountReadable { get; set; }
        public bool AccountIsLive { get; set; }
        public bool AccountNumberMatchesAllowlist { get; set; }
        public bool AccountSwitchedSinceArm { get; set; }

        // --- Símbolo ---
        public bool SymbolReadable { get; set; }
        public string SymbolRawName { get; set; }
        public bool TradingEnabled { get; set; }
        public bool TradingModeFullAccess { get; set; }
        public bool MarketOpen { get; set; }
        public long SecondsTillMarketClose { get; set; }
        public bool VolumeContractComplete { get; set; }
        public bool CommissionContractComplete { get; set; }

        // --- Cotización ---
        public bool QuoteEverReceived { get; set; }
        public long QuoteAgeMillis { get; set; }

        // --- Exposición y órdenes ---
        public PlatformPosition[] AttributablePositions { get; set; }
        public PlatformPosition[] UnattributablePositions { get; set; }
        public int PendingOrderCount { get; set; }

        // --- Conexión y presencia humana ---
        public bool Connected { get; set; }
        public bool HumanArmed { get; set; }
        public long HumanHeartbeatAgeMillis { get; set; }

        // --- Epochs (los mantiene el adaptador, no la plataforma) ---
        public bool ConnectionArmEnvironmentEpochUnchanged { get; set; }
        public bool CurrentSessionArmFresh { get; set; }
        public bool AuthorityHashMatches { get; set; }
        public bool JournalReady { get; set; }
        public bool SessionEntryAvailable { get; set; }
    }

    /// <summary>
    /// Resultado de una llamada de trading, en forma neutral.
    /// `CallReturned=false` significa que la llamada NO devolvió (excepción, timeout,
    /// desconexión): es el caso ambiguo, y jamás debe tratarse como "no pasó nada".
    /// </summary>
    public sealed class TradeOutcome
    {
        public TradeOutcome(bool callReturned, bool isSuccessful, string errorCode,
                            bool positionReturned, bool positionHasStopLoss, int positionId)
        {
            CallReturned = callReturned;
            IsSuccessful = isSuccessful;
            ErrorCode = errorCode == null ? string.Empty : errorCode;
            PositionReturned = positionReturned;
            PositionHasStopLoss = positionHasStopLoss;
            PositionId = positionId;
        }

        public bool CallReturned { get; private set; }
        public bool IsSuccessful { get; private set; }
        public string ErrorCode { get; private set; }
        public bool PositionReturned { get; private set; }
        public bool PositionHasStopLoss { get; private set; }
        public int PositionId { get; private set; }
    }

    /// <summary>
    /// Sobre de riesgo: es AQUÍ donde entran el volumen y la distancia de stop.
    /// Ningún artefacto aprobado los produce todavía (hueco declarado en la
    /// especificación). Por eso el puerto existe y su implementación por defecto
    /// DENIEGA: el sistema no puede operar hasta que alguien lo implemente.
    /// </summary>
    public sealed class RiskEnvelope
    {
        public RiskEnvelope(bool allow, string envelopeDigest, double volumeInUnits, double stopLossPips)
        {
            Allow = allow;
            EnvelopeDigest = envelopeDigest == null ? string.Empty : envelopeDigest;
            VolumeInUnits = volumeInUnits;
            StopLossPips = stopLossPips;
        }

        public bool Allow { get; private set; }
        public string EnvelopeDigest { get; private set; }
        public double VolumeInUnits { get; private set; }
        public double StopLossPips { get; private set; }

        public static RiskEnvelope Denied()
        {
            return new RiskEnvelope(false, string.Empty, 0d, 0d);
        }
    }

    // ----------------------------------------------------------------- PUERTOS

    /// <summary>
    /// Reloj MONOTÓNICO. El diseño exige WALL_CLOCK_UNUSED para la caducidad del
    /// permiso: el SDK solo ofrece reloj de pared (Server.Time), así que la fuente
    /// tiene que venir de fuera del SDK y ser la misma en emisión y consumo.
    /// `Epoch` cambia en cada arranque de proceso: por eso un reinicio invalida
    /// cualquier permiso emitido antes.
    /// </summary>
    public interface IMonotonicClock
    {
        long NowTicks { get; }
        long Epoch { get; }
    }

    /// <summary>Ventana de barras H1 ya cerradas, la más reciente al final.</summary>
    public interface IH1BarSource
    {
        PlatformBar[] ReadClosedWindow(int maxBars);
    }

    public interface IPlatformObserver
    {
        PlatformSnapshot Read();
    }

    /// <summary>
    /// Único punto por el que pueden salir efectos hacia el bróker.
    /// Toda llamada pasa por la compuerta serial del kernel.
    /// </summary>
    public interface IOrderEffectPort
    {
        TradeOutcome SubmitProtectedEntry(string symbolRawName, bool isBuy,
                                          double volumeInUnits, double stopLossPips, string label);
        TradeOutcome CloseAttributable(int positionId);
    }

    public interface IJournalPort
    {
        bool Ready { get; }
        void Append(string journalNamespace, string line);
        string TipDigest { get; }
        /// <summary>Huellas de intención ya actuadas; sostiene la idempotencia tras reinicio.</summary>
        bool HasActedOnIntent(string intentDigest);
        void RecordActedIntent(string intentDigest);
    }

    public interface IRiskEnvelopePort
    {
        RiskEnvelope Evaluate(string intentDigest);
    }

    public interface IRuntimeStop
    {
        void StopRuntime();
    }

    /// <summary>
    /// Implementación por defecto del sobre de riesgo: DENIEGA SIEMPRE.
    /// Es deliberado. Mientras el volumen y la distancia de stop no tengan un
    /// origen ratificado, el sistema debe ser incapaz de abrir una posición.
    /// </summary>
    public sealed class DenyingRiskEnvelopePort : IRiskEnvelopePort
    {
        public RiskEnvelope Evaluate(string intentDigest)
        {
            return RiskEnvelope.Denied();
        }
    }
}
